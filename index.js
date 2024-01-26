import "dotenv/config";

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  TextInputStyle,
  ModalBuilder,
  TextInputBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import * as fs from "fs";
import WebSocket from "ws";

const SCOPES = encodeURIComponent(
  [
    "user:read:chat",
    "moderator:manage:chat_messages",
    "moderator:manage:banned_users",
  ].join(" "),
);

const EVENTSUB_WSS_URL = "wss://eventsub.wss.twitch.tv/ws";
const EVENTSUB_SUB_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.User,
    Partials.Channel,
    Partials.GuildMember,
    Partials.Message,
    Partials.Reaction,
  ],
});

let tokens = {
  access_token: null,
  refresh_token: null,
  device_code: null,
  user_code: null,
  verfication_uri: null,
  user_id: null,
};

let modChannel = null;
let messages = [];
let usernameCreatedAtMapping = {};
let alreadySubscribedToEvent = false;
let exponentialBackoff = 0;

async function isOldEnough(username, minAge) {
  if (usernameCreatedAtMapping[username]) {
    let today = new Date();
    let createDate = new Date(usernameCreatedAtMapping[username]);
    let age = (today.getTime() - createDate.getTime()) / 1000;
    return age > minAge;
  } else {
    let today = new Date();
    usernameCreatedAtMapping[username] = (await getUser(username)).created_at;
    let createDate = new Date(usernameCreatedAtMapping[username]);
    let age = (today.getTime() - createDate.getTime()) / 1000;
    return age > minAge;
  }
}

async function handleDeleteButton(interaction) {
  await interaction.deferReply({
    ephemeral: process.env.EPHEMERAL.toLowerCase() == "true",
  });
  let message = messages.find(
    (msg) => msg.discordMessage.id == interaction.message.id,
  );
  if (message) {
    let deleteSuccess = await deleteChatMessage(
      (await getUser(process.env.BROADCASTER_LOGIN)).id,
      tokens.user_id,
      message.twitchMessage.message_id,
    );
    if (deleteSuccess) {
      await interaction.editReply({
        content: "Successfully deleted message!",
      });
    } else {
      await interaction.editReply({
        content: "Message deletetion failed!",
      });
    }
  } else {
    await interaction.editReply({
      content: "Couldn't find message mapping!",
    });
  }
}

async function handleTimeoutButton(interaction) {
  let modal = new ModalBuilder()
    .setTitle("Timeout")
    .setCustomId("timeoutModal")
    .setComponents(
      new ActionRowBuilder().setComponents(
        new TextInputBuilder()
          .setCustomId("timeoutLength")
          .setLabel("Length in Seconds")
          .setMaxLength(7)
          .setMinLength(1)
          .setPlaceholder("Length in Seconds")
          .setStyle(TextInputStyle.Short),
      ),
      new ActionRowBuilder().setComponents(
        new TextInputBuilder()
          .setCustomId("timeoutReason")
          .setLabel("Timeout Reason")
          .setRequired(false)
          .setPlaceholder("Timeout Reason")
          .setStyle(TextInputStyle.Short),
      ),
    );
  await interaction.showModal(modal);
  let submitted = await interaction
    .awaitModalSubmit({
      filter: (i) =>
        i.customId == "timeoutModal" && i.user.id == interaction.user.id,
      time: 60000,
    })
    .catch((err) => {
      console.error(err);
    });
  if (submitted) {
    let message = messages.find(
      (msg) => msg.discordMessage.id == interaction.message.id,
    );
    let timeoutLength = parseInt(
      submitted.fields.getTextInputValue("timeoutLength"),
      10,
    );
    let timeoutReason = submitted.fields.getTextInputValue("timeoutReason");
    if (!isNaN(timeoutLength)) {
      let timeoutSuccess = await timeout(
        (await getUser(process.env.BROADCASTER_LOGIN)).id,
        tokens.user_id,
        (await getUser(message.twitchMessage.chatter_user_login)).id,
        timeoutLength,
        reason,
      );
      if (timeoutSuccess) {
        await interaction.editReply({
          content: "Successfully timed out user!",
          ephemeral: process.env.EPHEMERAL.toLowerCase() == "true",
        });
      } else {
        await interaction.editReply({
          content: "Timing user out failed!",
          ephemeral: process.env.EPHEMERAL.toLowerCase() == "true",
        });
      }
    } else {
      await interaction.editReply({
        content: `Please only use integers for the timeout length!`,
        ephemeral: process.env.EPHEMERAL.toLowerCase() == "true",
      });
    }
  }
}

async function handleBanButton(interaction) {
  let modal = new ModalBuilder()
    .setTitle("Ban")
    .setCustomId("banModal")
    .setComponents(
      new ActionRowBuilder().setComponents(
        new TextInputBuilder()
          .setCustomId("banReason")
          .setLabel("Ban Reason")
          .setRequired(false)
          .setPlaceholder("Ban Reason")
          .setStyle(TextInputStyle.Short),
      ),
    );
  await interaction.showModal(modal);
  let submitted = await interaction
    .awaitModalSubmit({
      filter: (i) =>
        i.customId == "banModal" && i.user.id == interaction.user.id,
      time: 60000,
    })
    .catch((err) => {
      console.error(err);
    });
  if (submitted) {
    let message = messages.find(
      (msg) => msg.discordMessage.id == interaction.message.id,
    );
    let banReason = submitted.fields.getTextInputValue("banReason");
    let banSuccess = await ban(
      (await getUser(process.env.BROADCASTER_LOGIN)).id,
      tokens.user_id,
      (await getUser(message.twitchMessage.chatter_user_login)).id,
      reason,
    );
    if (banSuccess) {
      await interaction.editReply({
        content: "Successfully banned user!",
        ephemeral: process.env.EPHEMERAL.toLowerCase() == "true",
      });
    } else {
      await interaction.editReply({
        content: "Banning user failed!",
        ephemeral: process.env.EPHEMERAL.toLowerCase() == "true",
      });
    }
  }
}

async function setupEventSub() {
  let keepaliveTimeoutSeconds = {
    start: 0,
    end: 0,
    interval: 0,
  };
  let keepaliveTimeoutInterval = setInterval(() => {
    if (keepaliveTimeoutSeconds.start > 0 && keepaliveTimeoutSeconds.end > 0) {
      if (keepaliveTimeoutSeconds.end - keepaliveTimeoutSeconds.start > 10)
        setupEventSub();
    }
  }, 1000);
  let wsClient = new WebSocket(EVENTSUB_WSS_URL);
  let onopen = (event) => {
    console.log("EventSub connection established!");
    exponentialBackoff = 0;
  };
  let onmessage = async (event) => {
    let data = JSON.parse(event.data);
    if (data.metadata?.message_type == "session_welcome") {
      console.log("session_welcome: " + JSON.stringify(data));
      if (alreadySubscribedToEvent) {
        return;
      }
      let id = data.payload.session.id;
      keepaliveTimeoutSeconds.interval =
        data.payload.session.keepalive_timeout_seconds;
      // https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription
      await fetch(EVENTSUB_SUB_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Client-ID": process.env.TWITCH_CLIENT_ID,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "channel.chat.message",
          version: "1",
          condition: {
            broadcaster_user_id: tokens.user_id, // User ID of the channel to receive chat message events for.
            user_id: tokens.user_id, // The user ID to read chat as.
          },
          transport: {
            method: "websocket",
            session_id: id,
          },
        }),
      })
        .then(async (res) => {
          if (res.status != 202) {
            let json = await res.json();
            console.log(
              "Registering EventSub subscription failed: " +
                JSON.stringify(json),
            );
          }
        })
        .catch((err) => {
          console.log(err);
        });
      alreadySubscribedToEvent = true;
    } else if (data.metadata?.message_type == "session_keepalive") {
      console.log(`session_keepalive: ${JSON.stringify(data)}`);
    } else if (data.metadata?.message_type == "session_reconnect") {
      console.log(`session_reconnect: ${JSON.stringify(data)}`);
      console.log(`Reconnecting to ${data.payload.session.reconnect_url}`);
      wsClient = new WebSocket(data.payload.session.reconnect_url);
      wsClient.onopen = onopen;
      wsClient.onmessage = onmessage;
      wsClient.onclose = onclose;
      wsClient.onerror = onerror;
    } else if (data.payload?.subscription?.type == "channel.chat.message") {
      console.log(`channel.chat.message: ${JSON.stringify(data)}`);
      console.log(data.payload.event);
      if (
        !(await isOldEnough(
          data.payload.event.chatter_user_login,
          parseInt(process.env.MIN_AGE_SECONDS, 10),
        ))
      ) {
        console.log("Account not old enough!");
        messages.push({
          discordMessage: await modChannel.send({
            content: `${data.payload.event.chatter_user_name}: ${data.payload.event.message.text}`,
            components: [
              new ActionRowBuilder().setComponents(
                new ButtonBuilder()
                  .setCustomId("deleteBtn")
                  .setLabel("🗑️")
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId("timeoutBtn")
                  .setLabel("🕙")
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId("banBtn")
                  .setLabel("🚫")
                  .setStyle(ButtonStyle.Primary),
              ),
            ],
          }),
          twitchMessage: data.payload.event,
        });
      }
    } else {
      console.log(`EventSub Data: ${JSON.stringify(data)}`);
    }
    keepaliveTimeoutSeconds.start = Date.now() / 1000;
    keepaliveTimeoutSeconds.end =
      keepaliveTimeoutSeconds.start + keepaliveTimeoutSeconds.interval;
  };
  let onclose = async (event) => {
    if (!event.wasClean) {
      console.log(
        `Connection didn't close in a clean manner! Maybe just the connection was lost! Trying to reconnect... (exponential backoff: ${exponentialBackoff})`,
      );
      alreadySubscribedToEvent = false;
      if (exponentialBackoff == 0) {
        await setupEventSub();
        exponentialBackoff = 100;
      } else {
        setTimeout(async () => {
          await setupEventSub();
        }, exponentialBackoff);
      }
      exponentialBackoff *= 2;
    }
  };
  let onerror = (event) => {
    console.log("EventSub connection errored!");
  };
  wsClient.onopen = onopen;
  wsClient.onmessage = onmessage;
  wsClient.onclose = onclose;
  wsClient.onerror = onerror;
}

client.on(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`); // Logging
  modChannel = await client.channels.fetch(process.env.POSTING_CHANNEL_ID);
  await setupEventSub();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!process.env.POSTING_CHANNEL_ID) {
    interaction.reply({
      content: `Please first set a channel where you want me to accept the commands! For <#${interaction.channel.id}> (${interaction.channel.name}) just add the line \`POSTING_CHANNEL_ID=${interaction.channel.id}\` to .env!`,
      ephemeral: process.env.EPHEMERAL.toLowerCase() == "true",
    });
  } else if (interaction.channel.id != process.env.POSTING_CHANNEL_ID) {
    interaction.reply({
      content: `<#${interaction.channel.id}> (${interaction.channel.name}) is not allowed to accept commands!`,
      ephemeral: process.env.EPHEMERAL.toLowerCase() == "true",
    });
  } else {
    if (interaction.isChatInputCommand()) {
      // Should never happen - do nothing
    } else if (interaction.isButton()) {
      if (interaction.customId == "deleteBtn") {
        await handleDeleteButton(interaction);
      } else if (interaction.customId == "timeoutBtn") {
        await handleTimeoutButton(interaction);
      } else if (interaction.customId == "banBtn") {
        await handleBanButton(interaction);
      }
    }
  }
});

async function deleteRequest(url) {
  return await fetch(url, {
    method: "DELETE",
    headers: {
      "Client-ID": process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });
}

async function postRequest(url, body = null) {
  if (body) {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Client-ID": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify(body),
    });
  } else {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Client-ID": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });
  }
}

async function deleteChatMessage(
  broadcasterId,
  moderatorId,
  msgId,
  firstTry = true,
) {
  return await deleteRequest(
    `https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}&message_id=${msgId}`,
  ).then(async (res) => {
    // 204 = Success
    // 400 = "You may not delete another moderator's messages." or "You may not delete the broadcaster's messages."
    // 401 = "The Authorization header is required and must contain a user access token." or "The user access token is missing the moderator:manage:chat_messages scope." or "The OAuth token is not valid." or "The client ID specified in the Client-Id header does not match the client ID specified in the OAuth token."
    // 403 = "The user is not one of the broadcaster's moderators."
    // 404 = "The ID in message_id was not found." or "The specified message was created more than 6 hours ago."
    if (res.status >= 200 && res.status < 300) {
      return true;
    } else {
      if (firstTry) {
        if (await refresh()) {
          return await deleteChatMessage(
            broadcasterId,
            moderatorId,
            msgId,
            false,
          );
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
  });
}

async function timeout(
  broadcasterId,
  moderatorId,
  userId,
  duration,
  reason = null,
  firstTry = true,
) {
  let data = {
    duration,
    user_id: userId,
  };
  if (reason) data.reason = reason;
  return await postRequest(
    `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
    {
      data,
    },
  ).then(async (res) => {
    // 200 = Success
    // 400 = Bad Request
    // 401 = Unauthorized
    // 403 = Forbidden
    // 409 = Conflict. You may not update the user’s ban state while someone else is updating the state. For example, someone else is currently banning the user or putting them in a timeout, moving the user from a timeout to a ban, or removing the user from a ban or timeout. Please retry your request.
    // 429 = Too Many Requests. It is possible for too many ban requests to occur even within normal Twitch API rate limits.
    // 500 = Internal Server Error
    if (res.status >= 200 && res.status < 300) {
      return true;
    } else {
      if (firstTry) {
        if (await refresh()) {
          return await timeout(
            broadcasterId,
            moderatorId,
            userId,
            duration,
            reason,
            false,
          );
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
  });
}

async function ban(
  broadcasterId,
  moderatorId,
  userId,
  reason = null,
  firstTry = true,
) {
  let data = {
    user_id: userId,
  };
  if (reason) data.reason = reason;
  return await postRequest(
    `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
    {
      data,
    },
  ).then(async (res) => {
    // 200 = Success
    // 400 = Bad Request
    // 401 = Unauthorized
    // 403 = Forbidden
    // 409 = Conflict. You may not update the user’s ban state while someone else is updating the state. For example, someone else is currently banning the user or putting them in a timeout, moving the user from a timeout to a ban, or removing the user from a ban or timeout. Please retry your request.
    // 429 = Too Many Requests. It is possible for too many ban requests to occur even within normal Twitch API rate limits.
    // 500 = Internal Server Error
    if (res.status >= 200 && res.status < 300) {
      return true;
    } else {
      if (firstTry) {
        if (await refresh()) {
          return await ban(broadcasterId, moderatorId, userId, reason, false);
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
  });
}

async function getUser(login) {
  if (login) {
    return (
      await fetch(`https://api.twitch.tv/helix/users?login=${login}`, {
        headers: {
          "Client-ID": process.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }).then((res) => res.json())
    ).data[0];
  } else {
    return (
      await fetch("https://api.twitch.tv/helix/users", {
        headers: {
          "Client-ID": process.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }).then((res) => res.json())
    ).data[0];
  }
}

async function refresh() {
  console.log("Refreshing tokens...");
  let refreshResult = await fetch(
    `https://id.twitch.tv/oauth2/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(tokens.refresh_token)}&client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}`,
    {
      method: "POST",
      headers: {
        "Client-ID": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${tokens.access_token}`,
      },
    },
  );
  let refreshJson = await refreshResult.json();
  if (refreshResult.status >= 200 && refreshResult.status < 300) {
    // Successfully refreshed
    tokens.access_token = refreshJson.access_token;
    tokens.refresh_token = refreshJson.refresh_token;
    fs.writeFileSync("./.tokens.json", JSON.stringify(tokens));
    console.log("Successfully refreshed tokens!");
    return true;
  } else {
    // Refreshing failed
    console.log(`Failed refreshing tokens: ${JSON.stringify(refreshJson)}`);
    return false;
  }
}

async function validate() {
  return await fetch("https://id.twitch.tv/oauth2/validate", {
    method: "GET",
    headers: {
      "Client-ID": process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${tokens.access_token}`,
    },
  }).then(async (res) => {
    if (res.status) {
      if (res.status == 401) {
        return await refresh();
      } else if (res.status >= 200 && res.status < 300) {
        console.log("Successfully validated tokens!");
        return true;
      } else {
        console.error(
          `Unhandled validation error: ${JSON.stringify(await res.json())}`,
        );
        return false;
      }
    } else {
      console.error(
        `Unhandled network error! res.status is undefined or null! ${res}`,
      );
      return false;
    }
  });
}

if (!process.env.DISCORD_TOKEN) {
  console.log(
    "TOKEN not found! You must setup the Discord TOKEN as per the README file before running this bot.",
  );
} else {
  if (fs.existsSync("./.tokens.json")) {
    tokens = JSON.parse(fs.readFileSync("./.tokens.json"));
    let validated = await validate();
    if (validated) {
      client.login(process.env.DISCORD_TOKEN);
      setInterval(
        async () => {
          await validate();
        },
        60 * 60 * 1000 /*Run every hour*/,
      );
    }
  } else {
    let dcf = await fetch(
      `https://id.twitch.tv/oauth2/device?client_id=${process.env.TWITCH_CLIENT_ID}&scopes=${SCOPES}`,
      {
        method: "POST",
      },
    );
    if (dcf.status >= 200 && dcf.status < 300) {
      // Successfully got DCF data
      let dcfJson = await dcf.json();
      tokens.device_code = dcfJson.device_code;
      tokens.user_code = dcfJson.user_code;
      tokens.verification_uri = dcfJson.verification_uri;
      console.log(
        `Open ${tokens.verification_uri} in a browser and enter ${tokens.user_code} there!`,
      );
    }
    let dcfInterval = setInterval(async () => {
      let tokenPair = await fetch(
        `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&scopes=${encodeURIComponent(SCOPES)}&device_code=${tokens.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
        {
          method: "POST",
        },
      );
      if (tokenPair.status == 400) return; // Probably authorization pending
      if (tokenPair.status >= 200 && tokenPair.status < 300) {
        // Successfully got token pair
        let tokenJson = await tokenPair.json();
        tokens.access_token = tokenJson.access_token;
        tokens.refresh_token = tokenJson.refresh_token;
        let user = await getUser();
        tokens.user_id = user.id;
        fs.writeFileSync("./.tokens.json", JSON.stringify(tokens), {
          encoding: "utf8",
        });
        clearInterval(dcfInterval);
        console.log(
          `Got Device Code Flow Tokens for ${user.display_name} (${user.login})`,
        );
        client.login(process.env.DISCORD_TOKEN);
        setInterval(
          async () => {
            await validate();
          },
          60 * 60 * 1000 /*Run every hour*/,
        );
      }
    }, 1000);
  }
}
