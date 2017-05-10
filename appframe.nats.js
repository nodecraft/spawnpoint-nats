'use strict';

var fs = require('fs'),
	path = require('path');

var _ = require('lodash'),
	nats = require('nats'),
	EventEmitter2 = require('eventemitter2').EventEmitter2;

module.exports = require('appframe')().registerPlugin({
	dir: __dirname,
	name: "NATS",
	namespace: "nats",
	callback: true,
	exports: function(app, initCallback){

		// read TLS files
		if(app.config.nats && app.config.nats.connection.tls){
			if(app.config.nats.connection.tls.ca_file){
				app.config.nats.connection.tls.ca = [fs.readFileSync(path.join(app.cwd, app.config.nats.connection.tls.ca_file), 'utf8')];
				delete app.config.nats.connection.tls.ca_file;
			}
			if(app.config.nats.connection.tls.ca_files){
				var certs = [];
				_.each(app.config.nats.connection.tls.ca_files, function(caCert){
					certs.push(fs.readFileSync(path.join(app.cwd, caCert), 'utf8'));
				});
				app.config.nats.connection.tls.ca = certs;
				delete app.config.nats.connection.tls.ca_files;
			}
			if(app.config.nats.connection.tls.key_file){
				app.config.nats.connection.tls.key = fs.readFileSync(path.join(app.cwd, app.config.nats.connection.tls.key_file), 'utf8');
				delete app.config.nats.connection.tls.key_file;
			}
			if(app.config.nats.connection.tls.cert_file){
				app.config.nats.connection.tls.cert_file = fs.readFileSync(path.join(app.cwd, app.config.nats.connection.tls.cert_file), 'utf8');
				delete app.config.nats.connection.tls.cert_file;
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
					return app.nats.connection.publish(replyTo, {
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
					return app.nats.connection.publish(replyTo, {
						type: 'ack',
						timeout: timeout
					});
				});
				handler.on('update', function(results){
					return app.nats.connection.publish(replyTo, {
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
		app.nats = {
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
					options: _.defaults(options, app.config.nats.request_defaults),
					events: new EventEmitter2(),
					timeout: null
				};
				request.events.once('response', function(err, response){
					// perform cleanup
					request.events.removeAllListeners();
					app.nats.connection.unsubscribe(request.sid);
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
					request.sid = app.nats.connection.request(subject, msg, request.options.reply, handler);
					if(request.options.timeout){
						request.timeout = helpers.createTimeout(request);
					}
				}catch(err){
					error = err;
				}
				if(error){
					process.nextTick(function(){
						request.events.emit("response", app.errorCode("nats.publish_message_error", response));
					});
				}
				return request;
			},
			publish: function(subject, msg, callback){
				var error = null;
				try{
					return app.nats.connection.publish(subject, msg, callback || function(){});
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
				if(app.config.nats.subscribe_prefix && !options.noPrefix){
					subject = app.config.nats.subscribe_prefix + subject;
				}
				return app.nats.connection.subscribe(subject, options, function(response, replyTo, sentSubject){
					if(sentSubject && app.config.nats.subscribe_prefix && !options.noPrefix){
						sentSubject = sentSubject.slice(app.config.nats.subscribe_prefix.length || 0);
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
		app.nats.message = app.nats.publish;
		app.nats.handle = app.nats.subscribe;

		app.nats.live = false;
		app.nats.connection = nats.connect(app.config.nats.connection);
		app.nats.connection.once('connect', function(){
			app.log('Connected to NATS');
			app.nats.live = true;
			app.emit('app.register', 'nats');
			app.emit('nats.connected');
			return initCallback();
		});
		app.nats.connection.on('error', function(err){
			if(!app.nats.live){
				return initCallback(err);
			}
			app.error('NATS error!').debug(err);
		});
		app.nats.connection.on('reconnect', function(){
			app.emit('nats.reconnected');
			app.log('[NATS] Reconnected to server.');
		});
		app.nats.connection.on('reconnecting', function(){
			app.emit('nats.reconnecting');
			app.log('[NATS] Lost connection from server. Reconnecting...');
		});

		// handle shutdown
		app.once('app.close', function(){
			app.nats.connection.close();
			app.nats.connection.once('close', function(){
				app.log('[NATS] Closed connection to server.');
				return app.emit('app.deregister', 'nats');
			});
		});
	}
});