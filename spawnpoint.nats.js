'use strict';

const fs = require('fs'),
	path = require('path');

const _ = require('lodash'),
	nats = require('nats'),
	EventEmitter2 = require('eventemitter2').EventEmitter2;

module.exports = require('spawnpoint').registerPlugin({
	dir: __dirname,
	name: "NATS",
	namespace: "nats",
	callback: true,
	exports: function(app, initCallback){
		const config = app.config[this.namespace];
		const appNS = this.namespace;

		// read TLS files
		if(config && config.connection.tls){
			if(config.connection.tls.ca_file){
				config.connection.tls.ca = [fs.readFileSync(path.join(app.cwd, config.connection.tls.ca_file), 'utf8')];
				delete config.connection.tls.ca_file;
			}
			if(config.connection.tls.ca_files){
				var certs = [];
				_.each(config.connection.tls.ca_files, function(caCert){
					certs.push(fs.readFileSync(path.join(app.cwd, caCert), 'utf8'));
				});
				config.connection.tls.ca = certs;
				delete config.connection.tls.ca_files;
			}
			if(config.connection.tls.key_file){
				config.connection.tls.key = fs.readFileSync(path.join(app.cwd, config.connection.tls.key_file), 'utf8');
				delete config.connection.tls.key_file;
			}
			if(config.connection.tls.cert_file){
				config.connection.tls.cert_file = fs.readFileSync(path.join(app.cwd, config.connection.tls.cert_file), 'utf8');
				delete config.connection.tls.cert_file;
			}
		}

		var helpers = {
			createTimeout: function(request){
				var timeout = request.options.timeout;
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
				var handler = new EventEmitter2();
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
					if(isNaN(timeout) || timeout < 1){
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

				var request = {
					options: _.defaults(options, config.request_defaults),
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
				var handler = function(response){
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
				var error = null;
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
				var error = null;
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
				return app[appNS].connection.subscribe(subject, options, function(response, replyTo, sentSubject){
					if(sentSubject && config.subscribe_prefix && !options.noPrefix){
						sentSubject = sentSubject.slice(config.subscribe_prefix.length || 0);
					}
					var errored = response instanceof Error;
					if(errored){
						app.emit('nats.subscribe_message_error', response);
					}
					if(!replyTo){
						if(errored){ return; }
						return callback(response, null, sentSubject);
					}
					var handler = helpers.handler(replyTo);
					if(errored){
						return handler.response(app.errorCode("nats.subscribe_message_error", response));
					}
					if(!options.noAck){
						handler.ack();
					}
					return callback(response, handler, sentSubject);
				});
			}
		};
		app[appNS].message = app[appNS].publish;
		app[appNS].handle = app[appNS].subscribe;

		app[appNS].live = false;
		app[appNS].connection = nats.connect(config.connection);
		app[appNS].connection.once('connect', function(){
			app.log('[NATS] Connected to server');
			app[appNS].live = true;
			app.emit('app.register', 'nats');
			app.emit('nats.connected');
			return initCallback();
		});
		app[appNS].connection.on('error', function(err){
			if(!app[appNS].live){
				return initCallback(err);
			}
			app.error('NATS error!').debug(err);
		});
		app[appNS].connection.on('permission_error', function(err){
			app.emit('nats.permission_error');
			app.warn('[NATS] Permission error').debug(err);
		});
		app[appNS].connection.on('reconnect', function(){
			app.emit('nats.reconnected');
			app.log('[NATS] Reconnected to server.');
		});
		app[appNS].connection.on('reconnecting', function(){
			app.emit('nats.reconnecting');
			app.warn('[NATS] Lost connection from server. Reconnecting...');
		});
		app[appNS].connection.on('close', function(){
			app.emit('nats.close');
			app.warn('[NATS] Closed connection to server.');
		});

		// handle shutdown
		app.once('app.close', function(){
			app[appNS].connection.close();
			app[appNS].connection.once('close', function(){
				app.log('[NATS] Closed connection to server.');
				return app.emit('app.deregister', 'nats');
			});
		});
	}
});