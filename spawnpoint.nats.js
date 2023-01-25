'use strict';

const path = require('path');

const _ = require('lodash'),
	nats = require('nats'), // eslint-disable-line node/no-missing-require
	EventEmitter2 = require('eventemitter2').EventEmitter2;

module.exports = require('spawnpoint').registerPlugin({
	dir: __dirname,
	name: "NATS",
	namespace: "nats",
	callback: true,
	exports: function(app, initCallback){
		const jsonCodec = nats.JSONCodec();
		let init = false;
		new Promise(async (resolve, reject) => {

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
					config.connection.tls.certFile = path.join(app.cwd, config.connection.tls.cert_file);;
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
				createTimeout: function(request){
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
				handler: function(replyTo){
					const handler = new EventEmitter2();
					handler.once('response', function(err, results){
						handler.removeAllListeners();
						return app[appNS].connection.publish(replyTo, {
							type: 'response',
							results: results || null,
							error: err || null
						});
					});
					handler.on('ack', function(timeout){
						timeout = timeout || null;
						if(Number.isNaN(Number(timeout)) || timeout < 1){
							timeout = null;
						}
						return app[appNS].connection.publish(replyTo, {
							type: 'ack',
							timeout: timeout
						});
					});
					handler.on('update', function(results){
						return app[appNS].connection.publish(replyTo, {
							type: 'update',
							results: results
						});
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
				}
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
							...options,
							...config.request_defaults,
						},
						events: new EventEmitter2(),
						timeout: null
					};
					request.events.once('response', function(err, response){
						// perform cleanup
						request.events.removeAllListeners();
						app[appNS].connection.unsubscribe(request.sid);
						return callback(err, response);
					});
					request.events.on('update', updateCallback);
					const handler = function(response){
						switch(response.type){
							case "ack":
								if(request.timeout){
									clearTimeout(request.timeout);
									if(response.timeout){
										request.ack = response.timeout;
									}
									request.timeout = helpers.createTimeout(request);
								}
								request.events.emit("ack", response.results || {});
								break;
							case "update":
								if(request.timeout){
									clearTimeout(request.timeout);
									request.timeout = helpers.createTimeout(request);
								}
								request.events.emit("update", response.results || {});
								break;
							case "response":
								if(request.timeout){
									clearTimeout(request.timeout);
									request.timeout = helpers.createTimeout(request);
								}
								if(!response.error && response.results instanceof Error){
									response.error = response.results;
									response.results = null;
								}
								request.events.emit("response", response.error || null, response.results || null);
								break;
							default:
								app.warn('Invalid response received for request').debug(response);
						}
					};
					let error = null;
					try{
						request.sid = app[appNS].connection.request(subject, msg, request.options.reply, handler);
						if(request.options.timeout){
							request.timeout = helpers.createTimeout(request);
						}
					}catch(err){
						error = err;
					}
					if(error){
						process.nextTick(function(){
							request.events.emit("response", app.errorCode("nats.publish_message_error", error));
						});
					}
					return request;
				},
				publish: function(subject, msg, callback){
					let error = null;
					try{
						return app[appNS].connection.publish(subject, msg, callback || function(){});
					}catch(err){
						error = err;
					}
					if(error){
						return callback(error);
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
					console.log('sub', subject, options);
					try{
						const subscription = app[appNS].connection.subscribe(subject, options);
						(async () => {
							for await (const message of subscription){
								// console.dir(message, {depth: null});
								const handler = message.reply ? helpers.handler(message.reply) : null;
								const error = null; //nats.isRequestError(message);
								if(error){
									app.emit('nats.subscribe_message_error', response);
									handler?.response?.(app.errorCode("nats.subscribe_message_error", response));
								}else{
									const body = jsonCodec.decode(message.data);
									let sentSubject = message.subject;
									if(sentSubject && config.subscribe_prefix && !options.noPrefix){
										sentSubject = sentSubject.slice(config.subscribe_prefix.length || 0);
									}
									if(!options.noAck){
										handler?.ack?.();
									}
									callback(body, handler, sentSubject)
								}
							}
						})().then();
						console.log('got all msg lol')
					}catch(err){
						return callback(err);
					}
				}
			};
			app[appNS].message = app[appNS].publish;
			app[appNS].handle = app[appNS].subscribe;

			app[appNS].connection = await nats.connect(config.connection);
			// console.dir({nats}, {depth: null});
			// console.dir(app[appNS].connection, {depth: null});
			app.once('app.close', async () => {
				await app[appNS].connection.close();
			});
			app.emit('app.register', 'nats');
			app.emit('nats.connected');
			resolve();
			(async () => {
				for await (const status of app[appNS].connection.status()){
					if(status.type === 'reconnecting'){
						app.emit('nats.reconnecting');
						app.warn('[NATS] Lost connection from server. Reconnecting...');
					}else if(status.type === 'reconnect'){
						app.emit('nats.reconnected');
						app.log('[NATS] Reconnected to server.');
					}else{
						console.dir(status, {depth: null});
					}
				}
			})().then();
			await app[appNS].connection.closed();
			app.warn('[NATS] Closed connection to server.');
			app.emit('nats.close');
			app.emit('app.deregister', 'nats');
		}).then(() => {
			init = true;
			initCallback();
		}).catch((err) => {
			if(!init){
				init = true;
				initCallback(err);
			}
			app.emit('nats.error', err);
			app.error('[NATS] Error was triggered').debug(err);
		});
	}
});