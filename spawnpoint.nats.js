/* eslint-disable node/no-missing-require */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const _ = require('lodash');
const nats = require('nats');
const EventEmitter2 = require('eventemitter2').EventEmitter2;

module.exports = require('spawnpoint').registerPlugin({
	dir: __dirname,
	name: "NATS",
	namespace: "nats",
	callback: true,
	exports: function(app, initCallback){
		const jsonCodec = nats.JSONCodec();
		let init = false;
		(async () => {
			const config = app.config[this.namespace];
			const appNS = this.namespace;

			// read TLS files
			if(config && config.connection.tls){
				if(config.connection.tls.ca_file){
					config.connection.tls.caFile = path.join(app.cwd, config.connection.tls.ca_file);
					delete config.connection.tls.ca_file;
				}
				if(config.connection.tls.ca_files){
					const certs = [];
					for(const caCert of config.connection.tls.ca_files){
						certs.push(fs.readFileSync(path.join(app.cwd, caCert), 'utf8'));
					}
					config.connection.tls.ca = certs;
					delete config.connection.tls.ca_files;
				}
				if(config.connection.tls.key_file){
					config.connection.tls.keyFile = path.join(app.cwd, config.connection.tls.key_file);
					delete config.connection.tls.key_file;
				}
				if(config.connection.tls.cert_file){
					config.connection.tls.certFile = path.join(app.cwd, config.connection.tls.cert_file);
					delete config.connection.tls.cert_file;
				}
			}

			// set client name to "app@1.0.0 node@12.x.x"
			if(!config.connection.name && app.config.name){
				config.connection.name = app.config.name;
				if(app.config.version){
					config.connection.name += `@${app.config.version}`;
				}

				config.connection.name += ` node@${process.version}`;
			}

			const helpers = {
				wrapMessageError(error){
					if(error?.code === nats.ErrorCode.NoResponders){
						return app.errorCode("nats.no_responders");
					}else if(error?.code === nats.ErrorCode.Timeout){
						return app.errorCode("nats.timeout");
					}
					return app.errorCode('nats.publish_message_error', error);
				},
				createTimeout(request){
					let timeout = request.options.timeout;
					if(request.ack){
						timeout = request.ack;
						delete request.ack;
					}
					return setTimeout(function(){
						request.events.emit('timeout');
						request.events.emit('response', app.failCode('nats.timeout'));
					}, timeout);
				},
				handler(replyTo){
					const handler = new EventEmitter2();
					handler.once('response', function(err, results){
						handler.removeAllListeners();
						return app[appNS].connection.publish(replyTo, jsonCodec.encode({
							type: 'response',
							results: results || null,
							error: err || null,
						}));
					});
					handler.on('ack', function(timeout = null){
						if(Number.isNaN(Number(timeout)) || timeout < 1){
							timeout = null;
						}
						return app[appNS].connection.publish(replyTo, jsonCodec.encode({
							type: 'ack',
							timeout: timeout,
						}));
					});
					handler.on('update', function(results){
						return app[appNS].connection.publish(replyTo, jsonCodec.encode({
							type: 'update',
							results: results,
						}));
					});

					handler.ack = function(timeout){
						return handler.emit('ack', timeout);
					};
					handler.update = function(update){
						return handler.emit('update', update);
					};
					handler.response = function(err, results){
						return handler.emit('response', err, results);
					};
					return handler;
				},
			};
			app[appNS] = {
				request: function(subject, msg, options, callback, updateCallback){
					if(options && callback && !updateCallback && typeof(options) === 'function' && typeof(callback) === 'function'){
						updateCallback = callback;
						callback = options;
						options = {};
					}else if(options && !callback){
						callback = options;
						options = {};
					}
					callback = _.once(callback || function(){});
					updateCallback = updateCallback || function(){};

					const request = {
						options: {
							...config.request_defaults,
							...options,
						},
						events: new EventEmitter2(),
						timeout: null,
						maxWaitTimeout: null,
					};
					request.events.once('response', function(err, response){
						if(request.timeout){
							clearTimeout(request.timeout);
						}
						if(request.maxWaitTimeout){
							clearTimeout(request.maxWaitTimeout);
						}
						// perform cleanup
						request.events.removeAllListeners();
						if(request.asyncIterator){
							// stop the async iterator and run cleanup
							request.asyncIterator.stop();
						}
						return callback(err, response);
					});
					request.events.on('update', updateCallback);
					if(request.options.timeout){
						request.timeout = helpers.createTimeout(request);
					}
					// timeout is called maxWait in requestMany
					// store the promise so we can cancel it if needed
					(async () => {
						const manyOptions = {
							...request.options,
						};
						// maxWait is a special option for requestMany
						// it is the max time to wait for a response
						// if it is -1, it will wait "forever"
						// but we can't pass -1 to requestMany
						// so we pass the max 32 bit signed integer
						if(manyOptions.maxWait === -1){
							manyOptions.maxWait = 2_147_483_647;
						}
						request.maxWaitTimeout = setTimeout(() => {
							request.events.emit('timeout');
							request.events.emit('response', app.failCode('nats.timeout'));
						}, manyOptions.maxWait);
						request.asyncIterator = await app[appNS].connection.requestMany(subject, jsonCodec.encode(msg), manyOptions);
						for await(const req of request.asyncIterator){
							const response = jsonCodec.decode(req.data);
							switch(response.type){
								case "ack": {
									if(request.timeout){
										clearTimeout(request.timeout);
										if(response.timeout){
											request.ack = response.timeout;
										}
										request.timeout = helpers.createTimeout(request);
									}
									request.events.emit("ack", response.results || {});
									break;
								}
								case "update": {
									if(request.timeout){
										clearTimeout(request.timeout);
										request.timeout = helpers.createTimeout(request);
									}
									request.events.emit("update", response.results || {});
									break;
								}
								case "response": {
									if(!response.error && response.results instanceof Error){
										response.error = response.results;
										response.results = null;
									}
									request.events.emit("response", response.error || null, response.results || null);
									break;
								}
								default: {
									app.warn('Invalid response received for request').debug(response);
								}
							}
						}
					})().then(() => {}).catch((error) => {
						request.events.emit("response", helpers.wrapMessageError(error));
					});
				},
				publish: function(subject, msg, options, callback){
					if(!options && !callback){
						options = {};
						callback = () => {};
					}else if(options && !callback){
						callback = options;
						options = {};
					}
					const error = null;
					try{
						app[appNS].connection.publish(subject, jsonCodec.encode(msg), options);
						return callback(); // assume it was sent?
					}catch{
						return callback(helpers.wrapMessageError(error));
					}
				},
				subscribe: function(subject, options, callback){
					if(options && !callback){
						callback = options;
						options = {};
					}
					callback = callback || function(){};
					if(config.subscribe_prefix && !options.noPrefix){
						subject = config.subscribe_prefix + subject;
					}
					let subscription;
					(async () => {
						subscription = app[appNS].connection.subscribe(subject, options);
						for await(const message of subscription){
							const handler = message.reply ? helpers.handler(message.reply) : null;
							let sentSubject = message.subject;
							if(sentSubject && config.subscribe_prefix && !options.noPrefix){
								sentSubject = sentSubject.slice(config?.subscribe_prefix?.length ?? 0);
							}
							try{
								const body = jsonCodec.decode(message.data);
								if(!options.noAck){
									handler?.ack?.();
								}
								// eslint-disable-next-line callback-return
								callback(body, handler, sentSubject);
							}catch(error){
								app.emit('nats.subscribe_message_error', {
									subject: sentSubject,
									error,
								});
								handler?.response?.(app.errorCode("nats.subscribe_message_error", error));
							}
						}
					})().then().catch((err) => {
						const error = app.errorCode("nats.subscribe_message_error", err);
						app.emit('nats.subscribe_message_error', error);
						throw error;
					});
					return subscription;
				},
			};
			app[appNS].message = app[appNS].publish;
			app[appNS].handle = app[appNS].subscribe;

			app[appNS].connection = await nats.connect(config.connection);
			app.once('app.close', async () => {
				await app[appNS].connection.drain();
			});
			app.emit('app.register', 'nats');
			app.emit('nats.connected');
			init = true;
			initCallback();
			(async () => {
				for await(const status of app[appNS].connection.status()){
					if(status.type === 'reconnecting'){
						app.emit('nats.reconnecting');
						app.warn('[NATS] Lost connection from server. Reconnecting...');
					}else if(status.type === 'reconnect'){
						app.emit('nats.reconnected');
						app.log('[NATS] Reconnected to server.');
					}else if(status.type === 'error'){
						app.emit('nats.error', status.data);
						app.error('[NATS] Error was triggered').debug(app[appNS].connection.protocol.lastError);
					}
				}
			})().then();
			await app[appNS].connection.closed();
			app.warn('[NATS] Closed connection to server.');
			app.emit('nats.close');
			app.emit('app.deregister', 'nats');
		})().then().catch((err) => {
			if(!init){
				init = true;
				initCallback(err);
			}
			app.emit('nats.error', err);
			app.error('[NATS] Error was triggered').debug(err);
		});
	},
});