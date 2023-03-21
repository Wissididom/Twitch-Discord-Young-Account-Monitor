import * as dotenv from 'dotenv';
require('dotenv').config();

import {
	Client,
	GatewayIntentBits,
	Partials,
	TextInputStyle,
	ModalBuilder,
	TextInputBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle
} from 'discord.js';
import * as tmi from 'tmi.js';
import * as express from 'express';
//import fetch from 'node-fetch';
import * as fs from 'fs';
import open, {openApp, apps} from 'open';

dotenv.config();

/*
OBJECTS, TOKENS, GLOBAL VARIABLES
*/

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.DirectMessages
	],
	partials: [
		Partials.User,
		Partials.Channel,
		Partials.GuildMember,
		Partials.Message,
		Partials.Reaction
	]
});

const mySecret = process.env.DISCORD_TOKEN;

let tokens = {
	access_token: 'N/A',
	refresh_token: 'N/A'
};
let tmiClient = null;
let modChannel = null;
let messages = [];
let broadcasterId = null;
let usernameCreatedAtMapping = {};

async function isOldEnough(username, minAge) {
	if (usernameCreatedAtMapping[username]) {
		let today = new Date();
		let createDate = new Date(usernameCreatedAtMapping[username]);
		let age = (today.getTime() - createDate.getTime()) / 1000;
		return age > minAge;
	} else {
		let today = new Date();
		usernameCreatedAtMapping[username] = (await fetch(`https://api.twitch.tv/helix/users?login=${username}`, {
			headers: {
				'Client-ID': process.env.TWITCH_CLIENT_ID,
				'Authorization': `Bearer ${tokens.access_token}`
			}
		}).then(res => res.json()).catch(err => console.error)).data[0].created_at;
		let createDate = new Date(usernameCreatedAtMapping[username]);
		let age = (today.getTime() - createDate.getTime()) / 1000;
		return age > minAge;
	}
}

client.on("ready", async () => {
	console.log(`Logged in as ${client.user.tag}!`);  // Logging
	modChannel = await client.channels.fetch(process.env.POSTING_CHANNEL_ID);
	broadcasterId = (await fetch(`https://api.twitch.tv/helix/users`, {
		headers: {
			'Client-ID': process.env.TWITCH_CLIENT_ID,
			'Authorization': `Bearer ${tokens.access_token}`
		}
	}).then(res => res.json()).catch(err => console.error)).data[0].id;
	tmiClient = new tmi.Client({
		options: { debug: true },
		identity: {
			username: process.env.BROADCASTER_LOGIN,
			password: `oauth:${tokens.access_token}`
		},
		channels: [ process.env.BROADCASTER_LOGIN ]
	});
	tmiClient.connect();
	tmiClient.on('message', async (channel, tags, message, self) => {
		if (self) return; // Do not process messages we sent ourselves
		if (!(await isOldEnough(tags.username, parseInt(process.env.MIN_AGE_SECONDS, 10)))) {
			messages.push({
				dcMessage: await modChannel.send({
					content: `${tags['display-name']}: ${message}`,
					components: [new ActionRowBuilder().setComponents(
						new ButtonBuilder().setCustomId('deleteBtn').setLabel('🗑️').setStyle(ButtonStyle.Primary),
						new ButtonBuilder().setCustomId('timeoutBtn').setLabel('🕙').setStyle(ButtonStyle.Primary),
						new ButtonBuilder().setCustomId('banBtn').setLabel('🚫').setStyle(ButtonStyle.Primary)
					)]
				}),
				tmiMessage: {
					tags,
					content: message
				}
			});
		}
	});
});

client.on("interactionCreate", async interaction => {
	if (!process.env.POSTING_CHANNEL_ID) {
		interaction.reply({
			content: `Please first set a channel where you want me to accept the commands! For <#${interaction.channel.id}> (${interaction.channel.name}) just add the line \`POSTING_CHANNEL_ID=${interaction.channel.id}\` to .env!`,
			ephemeral: process.env.EPHEMERAL == 'true'
		});
	} else if (interaction.channel.id != process.env.POSTING_CHANNEL_ID) {
		interaction.reply({
			content: `<#${interaction.channel.id}> (${interaction.channel.name}) is not allowed to accept commands!`,
			ephemeral: process.env.EPHEMERAL == 'true'
		});
	} else {
		if (interaction.isChatInputCommand()) {
			// Should never happen - do nothing
		} else if (interaction.isButton()) {
			if (interaction.customId == 'deleteBtn') {
				await interaction.deferReply({ ephemeral: true });
				let message = messages.find(msg => msg.dcMessage.id == interaction.message.id);
				if (message) {
					tmiId = message.tmiMessage.tags.id;
					validate(false).then(async (value) => {
						fetch(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}&message_id=${tmiId}`, {
							method: 'DELETE',
							headers: {
								'Client-ID': process.env.TWITCH_CLIENT_ID,
								'Authorization': `Bearer ${tokens.access_token}`
							}
						}).then(data => {
							interaction.editReply({
								content: `Twitch's response code: ${data.status}`,
								ephemeral: true
							});
						}).catch(err => {
							interaction.editReply({
								content: `Error deleting the message: ${err}`,
								ephemeral: true
							});
						});
						// 204 = Success
						// 400 = "You may not delete another moderator's messages." or "You may not delete the broadcaster's messages."
						// 401 = "The Authorization header is required and must contain a user access token." or "The user access token is missing the moderator:manage:chat_messages scope." or "The OAuth token is not valid." or "The client ID specified in the Client-Id header does not match the client ID specified in the OAuth token."
						// 403 = "The user is not one of the broadcaster's moderators."
						// 404 = "The ID in message_id was not found." or "The specified message was created more than 6 hours ago."
					}).catch((err) => {
						interaction.editReply({
							content: 'Token validation/refresh failed!',
							ephemeral: true
						});
					});
				} else {
					interaction.editReply({
						content: 'Couldn\'t find message mapping!',
						ephemeral: true
					});
				}
			} else if (interaction.customId == 'timeoutBtn') {
				let modal = new ModalBuilder().setTitle('Timeout').setCustomId('timeoutModal').setComponents(
					new ActionRowBuilder().setComponents(new TextInputBuilder().setCustomId('timeoutLength').setLabel('Length in Seconds').setMaxLength(7).setMinLength(1).setPlaceholder('Length in Seconds').setStyle(TextInputStyle.Short)),
					new ActionRowBuilder().setComponents(new TextInputBuilder().setCustomId('timeoutReason').setLabel('Timeout Reason').setRequired(false).setPlaceholder('Timeout Reason').setStyle(TextInputStyle.Short))
				);
				await interaction.showModal(modal);
				let submitted = await interaction.awaitModalSubmit({
					filter: i => i.customId == 'timeoutModal' && i.user.id == interaction.user.id,
					time: 60000
				}).catch(err => {
					console.error(err);
				});
				if (submitted) {
					let timeoutLength = parseInt(submitted.fields.getTextInputValue('timeoutLength'), 10);
					if (!isNaN(timeoutLength)) {
						validate(false).then(async (value) => {
							fetch(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, {
								method: 'POST',
								headers: {
									'Client-ID': process.env.TWITCH_CLIENT_ID,
									'Authorization': `Bearer ${tokens.access_token}`
								},
								body: JSON.stringify({
									data: {
										duration: submitted.fields.getTextInputValue('timeoutLength'),
										reason: submitted.fields.getTextInputValue('timeoutReason'),
										user_id: (await fetch(`https://api.twitch.tv/helix/users?login=${submitted.fields.getTextInputValue('timeoutReason')}`, {
											headers: {
												'Client-ID': process.env.TWITCH_CLIENT_ID,
												'Authorization': `Bearer ${tokens.access_token}`
											}
										}).then(res => res.json()).catch(err => console.error)).data[0].id
									}
								})
							}).then(data => data.json()).then(json => {
								interaction.editReply({
									content: `Twitch's response: ${JSON.stringify(json)}`,
									ephemeral: true
								});
							}).catch(err => {
								interaction.editReply({
									content: `Error timeouting the user: ${err}`,
									ephemeral: true
								});
							});
							// 200 = Success
							// 400 = Bad Request
							// 401 = Unauthorized
							// 403 = Forbidden
							// 409 = Conflict. You may not update the user’s ban state while someone else is updating the state. For example, someone else is currently banning the user or putting them in a timeout, moving the user from a timeout to a ban, or removing the user from a ban or timeout. Please retry your request.
							// 429 = Too Many Requests. It is possible for too many ban requests to occur even within normal Twitch API rate limits.
							// 500 = Internal Server Error
						}).catch((err) => {
							interaction.editReply({
								content: 'Token validation/refresh failed!',
								ephemeral: true
							});
						});
					} else {
						interaction.editReply({
							content: `Please only use integers`,
							ephemeral: true
						});
					}
				}
			} else if (interaction.customId == 'banBtn') {
				let modal = new ModalBuilder().setTitle('Ban').setCustomId('banModal').setComponents(
					new ActionRowBuilder().setComponents(new TextInputBuilder().setCustomId('banReason').setLabel('Ban Reason').setRequired(false).setPlaceholder('Ban Reason').setStyle(TextInputStyle.Short))
				);
				await interaction.showModal(modal);
				let submitted = await interaction.awaitModalSubmit({
					filter: i => i.customId == 'banModal' && i.user.id == interaction.user.id,
					time: 60000
				}).catch(err => {
					console.error(err);
				});
				if (submitted) {
					validate(false).then(async (value) => {
						fetch(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, {
							method: 'POST',
							headers: {
								'Client-ID': process.env.TWITCH_CLIENT_ID,
								'Authorization': `Bearer ${tokens.access_token}`
							},
							body: JSON.stringify({
								data: {
									reason: submitted.fields.getTextInputValue('timeoutReason'),
									user_id: (await fetch(`https://api.twitch.tv/helix/users?login=${submitted.fields.getTextInputValue('banReason')}`, {
										headers: {
											'Client-ID': process.env.TWITCH_CLIENT_ID,
											'Authorization': `Bearer ${tokens.access_token}`
										}
									}).then(res => res.json()).catch(err => console.error)).data[0].id
								}
							})
						}).then(data => data.json()).then(json => {
							interaction.editReply({
								content: `Twitch's response: ${JSON.stringify(json)}`,
								ephemeral: true
							});
						}).catch(err => {
							interaction.editReply({
								content: `Error timeouting the user: ${err}`,
								ephemeral: true
							});
						});
					}).catch((err) => {
						interaction.editReply({
							content: 'Token validation/refresh failed!',
							ephemeral: true
						});
					});
				}
			}
		}
	}
});

function validate(openBrowser = true) {
	return new Promise((resolve, reject) => {
		fetch('https://id.twitch.tv/oauth2/validate', {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${tokens.access_token}`
			}
		}).then(res => res.json()).then(async (res) => {
			if (res.status) {
				if (res.status == 401) {
					console.log('Trying to refresh with the refresh token');
					await fetch(`https://id.twitch.tv/oauth2/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(tokens.refresh_token)}&client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}`, {
						method: 'POST',
						headers: {
							'Client-ID': process.env.TWITCH_CLIENT_ID,
							'Authorization': `Bearer ${tokens.access_token}`
						}
					}).then(res => res.json()).then(res => {
						if (res.status) {
							console.log('Failed to refresh the token! Try to reauthenticate!');
							console.log(`Status: ${res.status}`);
							console.log(`Error-Message: ${res.message}`);
							console.log(`Open the following Website to authenticate: https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=http%3A%2F%2Flocalhost%3A${process.env.LOCAL_SERVER_PORT}&response_type=code&scope=chat%3Aread%20chat%3Aread%20moderator%3Amanage%3Achat_messages%20moderator%3Amanage%3Abanned_users`);
							if (openBrowser)
								open(`https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=http%3A%2F%2Flocalhost%3A${process.env.LOCAL_SERVER_PORT}&response_type=code&scope=chat%3Aread%20chat%3Aread%20moderator%3Amanage%3Achat_messages%20moderator%3Amanage%3Abanned_users`);
						} else {
							tokens = res;
							fs.writeFileSync('./.tokens.json', JSON.stringify(res));
							console.log('Tokens saved!');
							resolve('Tokens successfully refreshed!');
						}
					}).catch(err => {
						console.log('Failed to refresh the token! Try to reauthenticate!');
						console.error(err);
						console.log(`Open the following Website to authenticate: https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=http%3A%2F%2Flocalhost%3A${process.env.LOCAL_SERVER_PORT}&response_type=code&scope=chat%3Aread%20chat%3Aread%20moderator%3Amanage%3Achat_messages%20moderator%3Amanage%3Abanned_users`);
						if (openBrowser)
							open(`https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=http%3A%2F%2Flocalhost%3A${process.env.LOCAL_SERVER_PORT}&response_type=code&scope=chat%3Aread%20chat%3Aread%20moderator%3Amanage%3Achat_messages%20moderator%3Amanage%3Abanned_users`);
					});
				} else {
					console.log(`Status: ${res.status}`);
					console.log(`Error-Message: ${res.message}`);
					reject("Tokens couldn't be refreshed!");
				}
			} else {
				console.log('Validating...');
				console.log(`Client-ID: ${res.client_id}`);
				console.log(`Login-Name: ${res.login}`);
				console.log(`Scopes: ${res.scopes.join(', ')}`);
				console.log(`User-ID: ${res.user_id}`);
				console.log(`Expires in: ${res.expires_in} seconds`);
				resolve('Successfully validated!');
			}
		}).catch(err => {
			reject('Validation failed!');
		});
	});
}

const server = express();
server.all('/', async (req, res) => {
	const authObj = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&code=${req.query.code}&grant_type=authorization_code&redirect_uri=http%3A%2F%2Flocalhost%3A${process.env.LOCAL_SERVER_PORT}`, {
		method: 'POST'
	}).then(res => res.json()).catch(err => console.error);
	if (authObj.access_token) {
		tokens = authObj;
		fs.writeFileSync('./.tokens.json', JSON.stringify(authObj));
		res.send('<html>Tokens saved!</html>');
		console.log('Tokens saved!');
	} else
		res.send("Couldn't get the access token!");
		console.log("Couldn't get the access token!");
});
server.listen(parseInt(process.env.LOCAL_SERVER_PORT), () => {
	console.log('Express Server ready!');
	if (!fs.existsSync('./.tokens.json')) {
		console.log(`Open the following Website to authenticate: https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=http%3A%2F%2Flocalhost%3A${process.env.LOCAL_SERVER_PORT}&response_type=code&scope=chat%3Aread%20chat%3Aread%20moderator%3Amanage%3Achat_messages%20moderator%3Amanage%3Abanned_users`);
		open(`https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=http%3A%2F%2Flocalhost%3A${process.env.LOCAL_SERVER_PORT}&response_type=code&scope=chat%3Aread%20chat%3Aread%20moderator%3Amanage%3Achat_messages%20moderator%3Amanage%3Abanned_users`);
	}
});
if (!mySecret) {
	console.log("TOKEN not found! You must setup the Discord TOKEN as per the README file before running this bot.");
	process.kill(process.pid, 'SIGTERM');  // Kill Bot
} else {
	if (fs.existsSync('./.tokens.json')) {
		tokens = require('./.tokens.json');
		validate().then(() => {
			// Logs in with secret TOKEN
			client.login(mySecret);
		}).catch(() => {
			console.log('Failed to validate token, refresh token or authenticate!');
			process.kill(process.pid, 'SIGTERM');
		});
	}
}
