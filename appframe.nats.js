'use strict';
var _ = require('lodash'),
	nats = require('nats'),
	EventEmitter2 = require('eventemitter2').EventEmitter2;

module.exports = require('appframe')().registerPlugin({
	dir: __dirname,
	name: "NATS",
	namespace: "nats",
	callback: true,
	exports: function(app, initCallback){
		var helpers = {
			createTimeout: function(request){
				return setTimeout(function(){
					request.events.emit('timeout');
					request.events.emit('response', app.failCode('nats.timeout'));
				}, request.options.timeout);
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
				handler.on('ack', function(){
					return app.nats.connection.publish(replyTo, {type: 'ack'});
				});
				handler.on('update', function(results){
					return app.nats.connection.publish(replyTo, {
						type: 'update',
						results: results
					});
				});

				handler.ack = function(){
					return handler.emit('ack');
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
				if(options && !callback){
					callback = options;
					options = {};
				}
				callback = _.once(callback || function(){});
				updateCallback = updateCallback || function(){};

				var request = {
					options: _.defaults(options, app.config.nats.requestDefaults),
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
				request.sid = app.nats.connection.request(subject, msg, request.options.reply, function(response){
					switch(response.type){
						case "ack":
						case "update":
							if(request.timeout){
								clearTimeout(request.timeout);
								request.timeout = helpers.createTimeout(request);
							}
							request.events.emit(response.type, response.results || {});
							break;
						case "response":
							if(request.timeout){
								clearTimeout(request.timeout);
								request.timeout = helpers.createTimeout(request);
							}
							request.events.emit("response", response.error || null, response.results || null);
							break;
						default:
							app.warn('Invalid response received for request').debug(response);
					}
				});
				if(request.options.timeout){
					request.timeout = helpers.createTimeout(request);
				}

				return request;
			},
			publish: function(subject, msg, callback){
				return app.nats.connection.publish(subject, msg, callback || function(){});
			},
			subscribe: function(subject, options, callback){
				if(options && !callback){
					callback = options;
					options = {};
				}
				callback = callback || function(){};
				return app.nats.connection.subscribe(subject, options, function(response, replyTo){
					var handler = helpers.handler(replyTo);
					if(!options.noAck){
						handler.ack();
					}
					return callback(response, handler);
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
			app.error('NATS error!').debug(err);
			if(!app.nats.live){
				return initCallback(err);
			}
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