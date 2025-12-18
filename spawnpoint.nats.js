'use strict';

const fs = require('node:fs');
const path = require('node:path');

const eventemitter2 = require('eventemitter2');
const _ = require('lodash');
const nats = require('nats');

const EventEmitter2 = eventemitter2.EventEmitter2;

module.exports = require('spawnpoint').registerPlugin({
	dir: __dirname,
	name: 'NATS',
	namespace: 'nats',
	callback: true,
	exports: function(app, initCallback) {
		const jsonCodec = nats.JSONCodec();
		let init = false;
		(async () => {
			const config = app.config[this.namespace];
			const appNS = this.namespace;

			// read TLS files
			if (config && config.connection.tls) {
				if (config.connection.tls.ca_file) {
					config.connection.tls.caFile = path.join(app.cwd, config.connection.tls.ca_file);
					delete config.connection.tls.ca_file;
				}
				if (config.connection.tls.ca_files) {
					const certs = [];
					for (const caCert of config.connection.tls.ca_files) {
						certs.push(fs.readFileSync(path.join(app.cwd, caCert), 'utf8'));
					}
					config.connection.tls.ca = certs;
					delete config.connection.tls.ca_files;
				}
				if (config.connection.tls.key_file) {
					config.connection.tls.keyFile = path.join(app.cwd, config.connection.tls.key_file);
					delete config.connection.tls.key_file;
				}
				if (config.connection.tls.cert_file) {
					config.connection.tls.certFile = path.join(app.cwd, config.connection.tls.cert_file);
					delete config.connection.tls.cert_file;
				}
			}

			// set client name to "app@1.0.0 node@12.x.x"
			if (!config.connection.name && app.config.name) {
				config.connection.name = app.config.name;
				if (app.config.version) {
					config.connection.name += `@${app.config.version}`;
				}

				config.connection.name += ` node@${process.version}`;
			}

			// Setup an authenticator if available
			if (config.connection.auth) {
				// We want to read in the creds file given to us
				const authCredsFile = path.join(app.cwd, config.connection.auth.creds_file);
				delete config.connection.auth.creds_file;
				const authCreds = fs.readFileSync(authCredsFile);
				// Create a new credsAuthenticator
				config.connection.authenticator = nats.credsAuthenticator(authCreds);
				delete config.connection.auth;
			}

			// Shared state for lazy connection
			let connectPromise = null;

			// Register close handler at initialization - this ensures we always handle
			// app.close even if no connection was ever made (fixes lazy mode shutdown bug)
			app.once('app.close', async () => {
				// Wait for any pending connection to complete first (handles race condition
				// where shutdown happens while connection is being established)
				if (connectPromise) {
					try {
						await connectPromise;
					} catch {
						// Connection failed during shutdown - nothing to drain
						// Emit deregister since the closed() handler won't be set up
						app.emit('app.deregister', 'nats');
						return;
					}
				}

				// If no connection was ever made (lazy mode with no NATS operations),
				// just deregister - there's nothing to drain
				if (!app[appNS].connection) {
					app.emit('app.deregister', 'nats');
					return;
				}

				// Drain the connection gracefully
				// The closed() handler will emit 'app.deregister' after drain completes
				try {
					await app[appNS].connection.drain();
				} catch (drainError) {
					// drain() can fail if connection is already closed or in a bad state
					// Log the error but don't throw - the closed() handler should still
					// fire and emit deregister, or if not, spawnpoint's timeout will kick in
					app.error('[NATS] Error draining connection during shutdown').debug(drainError);
				}
			});

			// Helper to perform the actual connection
			async function doConnect() {
				app[appNS].connection = await nats.connect(config.connection);

				app.emit('nats.connected');

				// Start status monitoring in the background
				(async () => {
					for await (const status of app[appNS].connection.status()) {
						if (status.type === 'reconnecting') {
							app.emit('nats.reconnecting');
							app.warn('[NATS] Lost connection from server. Reconnecting...');
						} else if (status.type === 'reconnect') {
							app.emit('nats.reconnected');
							app.log('[NATS] Reconnected to server.');
						} else if (status.type === 'error') {
							app.emit('nats.error', status.data);
							app.error('[NATS] Error was triggered').debug(app[appNS].connection.protocol.lastError);
						}
					}
				})().then();

				// Wait for connection to close (in background)
				(async () => {
					await app[appNS].connection.closed();
					app.warn('[NATS] Closed connection to server.');
					app.emit('nats.close');
					app.emit('app.deregister', 'nats');
				})().then();

				return app[appNS].connection;
			}

			// Ensure connection exists, connecting lazily if needed
			async function ensureConnected() {
				if (app[appNS].connection) {
					return app[appNS].connection;
				}
				if (connectPromise) {
					return connectPromise;
				}
				connectPromise = doConnect();
				try {
					await connectPromise;
					connectPromise = null; // Clear for clean state
					return app[appNS].connection;
				} catch (err) {
					connectPromise = null; // Allow retry on failure
					throw err;
				}
			}

			const helpers = {
				wrapMessageError(error) {
					if (error?.code === nats.ErrorCode.NoResponders) {
						return app.errorCode('nats.no_responders');
					} else if (error?.code === nats.ErrorCode.Timeout) {
						return app.errorCode('nats.timeout');
					}
					return app.errorCode('nats.publish_message_error', error);
				},
				createTimeout(request) {
					let timeout = request.options.timeout;
					if (request.ack) {
						timeout = request.ack;
						delete request.ack;
					}
					return setTimeout(function() {
						request.events.emit('timeout');
						request.events.emit('response', app.failCode('nats.timeout'));
					}, timeout);
				},
				handler(replyTo) {
					const handler = new EventEmitter2();
					handler.once('response', function(err, results) {
						handler.removeAllListeners();
						return app[appNS].connection.publish(replyTo, jsonCodec.encode({
							type: 'response',
							results: results || null,
							error: err || null,
						}));
					});
					handler.on('ack', function(timeout = null) {
						if (Number.isNaN(Number(timeout)) || timeout < 1) {
							timeout = null;
						}
						return app[appNS].connection.publish(replyTo, jsonCodec.encode({
							type: 'ack',
							timeout: timeout,
						}));
					});
					handler.on('update', function(results) {
						return app[appNS].connection.publish(replyTo, jsonCodec.encode({
							type: 'update',
							results: results,
						}));
					});

					handler.ack = function(timeout) {
						return handler.emit('ack', timeout);
					};
					handler.update = function(update) {
						return handler.emit('update', update);
					};
					handler.response = function(err, results) {
						return handler.emit('response', err, results);
					};
					return handler;
				},
			};

			// Internal implementation of publish (assumes connection exists)
			function doPublish(subject, msg, options, callback) {
				try {
					app[appNS].connection.publish(subject, jsonCodec.encode(msg), options);
					return callback(); // assume it was sent?
				} catch (err) {
					return callback(helpers.wrapMessageError(err));
				}
			}

			// Internal implementation of subscribe (assumes connection exists)
			function doSubscribe(subject, options, callback) {
				const subscription = app[appNS].connection.subscribe(subject, options);
				(async () => {
					for await (const message of subscription) {
						const handler = message.reply ? helpers.handler(message.reply) : null;
						let sentSubject = message.subject;
						if (sentSubject && config.subscribe_prefix && !options.noPrefix) {
							sentSubject = sentSubject.slice(config?.subscribe_prefix?.length ?? 0);
						}
						try {
							const body = jsonCodec.decode(message.data);
							if (!options.noAck) {
								handler?.ack?.();
							}
							// eslint-disable-next-line callback-return
							callback(body, handler, sentSubject);
						} catch (error) {
							app.emit('nats.subscribe_message_error', {
								subject: sentSubject,
								error,
							});
							handler?.response?.(app.errorCode('nats.subscribe_message_error', error));
						}
					}
				})().then().catch((err) => {
					const error = app.errorCode('nats.subscribe_message_error', err);
					app.emit('nats.subscribe_message_error', error);
					throw error;
				});
				return subscription;
			}

			// Internal implementation of request (assumes connection exists)
			function doRequest(subject, msg, options, callback, updateCallback, request) {
				(async () => {
					const manyOptions = {
						...request.options,
					};
					// maxWait is a special option for requestMany
					// it is the max time to wait for a response
					// if it is -1, it will wait "forever"
					// but we can't pass -1 to requestMany
					// so we pass the max 32 bit signed integer
					if (manyOptions.maxWait === -1) {
						manyOptions.maxWait = 2_147_483_647;
					}
					request.maxWaitTimeout = setTimeout(() => {
						request.events.emit('timeout');
						request.events.emit('response', app.failCode('nats.timeout'));
					}, manyOptions.maxWait);
					request.asyncIterator = await app[appNS].connection.requestMany(subject, jsonCodec.encode(msg), manyOptions);
					for await (const req of request.asyncIterator) {
						const response = jsonCodec.decode(req.data);
						switch (response.type) {
							case 'ack': {
								if (request.timeout) {
									clearTimeout(request.timeout);
									if (response.timeout) {
										request.ack = response.timeout;
									}
									request.timeout = helpers.createTimeout(request);
								}
								request.events.emit('ack', response.results || {});
								break;
							}
							case 'update': {
								if (request.timeout) {
									clearTimeout(request.timeout);
									request.timeout = helpers.createTimeout(request);
								}
								request.events.emit('update', response.results || {});
								break;
							}
							case 'response': {
								if (!response.error && response.results instanceof Error) {
									response.error = response.results;
									response.results = null;
								}
								request.events.emit('response', response.error || null, response.results || null);
								break;
							}
							default: {
								app.warn('Invalid response received for request').debug(response);
							}
						}
					}
				})().then(() => {}).catch((error) => {
					request.events.emit('response', helpers.wrapMessageError(error));
				});
			}

			app[appNS] = {
				// Manual connect method for pre-warming connection
				connect: async function() {
					return ensureConnected();
				},

				request: function(subject, msg, options, callback, updateCallback) {
					if (options && callback && !updateCallback && typeof(options) === 'function' && typeof(callback) === 'function') {
						updateCallback = callback;
						callback = options;
						options = {};
					} else if (options && !callback) {
						callback = options;
						options = {};
					}
					callback = _.once(callback || function() {});
					updateCallback = updateCallback || function() {};

					const request = {
						options: {
							...config.request_defaults,
							...options,
						},
						events: new EventEmitter2(),
						timeout: null,
						maxWaitTimeout: null,
					};
					request.events.once('response', function(err, response) {
						if (request.timeout) {
							clearTimeout(request.timeout);
						}
						if (request.maxWaitTimeout) {
							clearTimeout(request.maxWaitTimeout);
						}
						// perform cleanup
						request.events.removeAllListeners();
						if (request.asyncIterator) {
							// stop the async iterator and run cleanup
							request.asyncIterator.stop();
						}
						return callback(err, response);
					});
					request.events.on('update', updateCallback);

					// In lazy mode, ensure connection before starting request
					// Start timeout only after connection is established to avoid premature timeouts
					if (config.lazy && !app[appNS].connection) {
						ensureConnected().then(() => {
							if (request.options.timeout) {
								request.timeout = helpers.createTimeout(request);
							}
							doRequest(subject, msg, options, callback, updateCallback, request);
						}).catch((error) => {
							request.events.emit('response', helpers.wrapMessageError(error));
						});
					} else {
						if (request.options.timeout) {
							request.timeout = helpers.createTimeout(request);
						}
						doRequest(subject, msg, options, callback, updateCallback, request);
					}

					return request.events;
				},

				publish: function(subject, msg, options, callback) {
					if (!options && !callback) {
						options = {};
						callback = () => {};
					} else if (options && !callback) {
						callback = options;
						options = {};
					}

					// In lazy mode, ensure connection before publishing
					if (config.lazy && !app[appNS].connection) {
						ensureConnected().then(() => {
							doPublish(subject, msg, options, callback);
						}).catch((err) => {
							callback(helpers.wrapMessageError(err));
						});
						return;
					}

					doPublish(subject, msg, options, callback);
				},

				subscribe: function(subject, options, callback) {
					if (options && !callback) {
						callback = options;
						options = {};
					}
					callback = callback || function() {};
					if (config.subscribe_prefix && !options.noPrefix) {
						subject = config.subscribe_prefix + subject;
					}

					// In lazy mode without existing connection, return a proxy
					if (config.lazy && !app[appNS].connection) {
						let realSub = null;
						let cancelled = false;
						let connectionFailed = false;
						let connectionError = null;

						const proxy = {
							unsubscribe: function(max) {
								if (realSub) {
									return realSub.unsubscribe(max);
								}
								cancelled = true;
							},
							drain: async function() {
								if (realSub) {
									return realSub.drain();
								}
								cancelled = true;
							},
							get isClosed() {
								return cancelled || connectionFailed || (realSub ? realSub.isClosed : false);
							},
							get error() {
								return connectionError;
							},
							getSubject: function() {
								return subject;
							},
							getMax: function() {
								return options.max;
							},
							getReceived: function() {
								return realSub ? realSub.getReceived() : 0;
							},
							getProcessed: function() {
								return realSub ? realSub.getProcessed() : 0;
							},
							getPending: function() {
								return realSub ? realSub.getPending() : 0;
							},
							getID: function() {
								return realSub ? realSub.getID() : 0;
							},
						};

						// Start connection and subscription asynchronously
						ensureConnected().then(() => {
							if (cancelled) {
								return;
							}
							realSub = doSubscribe(subject, options, callback);
						}).catch((err) => {
							connectionFailed = true;
							connectionError = err;
							app.emit('nats.subscribe_connection_error', {
								subject: subject,
								error: err,
							});
							app.emit('nats.error', err);
							app.error('[NATS] Lazy connect failed during subscribe').debug(err);
						});

						return proxy;
					}

					return doSubscribe(subject, options, callback);
				},
			};
			app[appNS].message = app[appNS].publish;
			app[appNS].handle = app[appNS].subscribe;

			// Register the plugin immediately (API is available)
			app.emit('app.register', 'nats');

			// In lazy mode, skip immediate connection
			// Note: Close handler is already registered above, so shutdown will work
			// even if no NATS operations ever trigger a connection
			if (config.lazy) {
				init = true;
				initCallback();
				return;
			}

			// Eager mode: connect immediately (existing behavior)
			await doConnect();
			init = true;
			initCallback();
		})().then().catch((err) => {
			if (!init) {
				init = true;
				initCallback(err);
			}
			app.emit('nats.error', err);
			app.error('[NATS] Error was triggered').debug(err);
		});
	},
});
