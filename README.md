# appframe-nats.js
[NATS](http://nats.io/) Plugin for Appleframe on NPM

## API
This api uis mounted at `app.nats` to access these methods:

##### `app.nats.publish(subject, message, callback)`
Sends a message to a subscriber. Expects no response. Callback issued when message is sent to the NATS server. No guarantee of receipt.
 - `subject` *string* - subject to publish message to
 - `message` *object|array|string|buffer* - Message body for published message
 - `callback *function* - Optional callback fired when sent

##### `app.nats.request(subject, message, options, callback, updateCallback)`
Sends a message to a subscriber with the expectation of at least one reply. Main callback only listens for the final reply. Can get updates to provide realtime stats/progress and/or acknowledgments to reset timeouts. Returns event emitter for `update`, `ack`, `response`, & `timeout events.

 - `subject` *string* - subject to publish message to
 - `message` *object|array|string|buffer* - Message body for published message
 - `options` *object* - Options passed to `PUB` [method](http://nats.io/documentation/internals/nats-protocol/#PUB).
   - `max` *number* - Number of replies to receive before unsubscribing from replies, optional
   - `timeout` *number* - Number of ms to wait until firing a timeout error. If omitted it will default to config settings. Setting to falsey value will disable timeout
 - `callback *function* - Optional callback fired when final response is sent. Callback includes two arguments
   - `err` *error|null* - If the response failed via timeout or was reported as an error from the response.
   - `results` **object|array|string|buffer* - Response body
 - `updateCallback *function* - Optional callback fired when update is sent. Callback includes one argument
   - `results` **object|array|string|buffer* - Response body

###### Example:
 ```javascript
 app.nats.request('lookup', {
		domain: "google.com"
	}, function(err, results){
      if(err){
        return console.error('ERROR', err);
      }
		  console.log('Lookup results', results);
	}, function(update){
    console.log('update', update);
  });
  ```
  
  ##### `app.nats.subscribe(subject, options, callback, updateCallback)`
Sends a message to a subscriber with the expectation of at least one reply. Main callback only listens for the final reply. Can get updates to provide realtime stats/progress and/or acknowledgments to reset timeouts. Returns event emitter for `update`, `ack`, `response`, & `timeout events.

 - `subject` *string* - subject to subscribe to
 - `options` *object* - Options passed to `PUB` [method](http://nats.io/documentation/internals/nats-protocol/#PUB).
   - `queue` *string* - Name of queue to join
   - `max` *number* - Maximum number of messages to receive before automatically unsubscribing.
   - `noAck` *boolean* - Prevents automatic `ack` message when set to true. Defaults to false.
   - `noPrefix` *string* - Prefixes subscription subjects with string. Defaults to blank string
 - `callback *function* - callback fired when messages are received. Callback includes two arguments
   - `response` *object|array|string|buffer* - Message body
   - `handler` *eventEmitter* - Event emitter with helper methods to handle updates, acks, and replies.
     - Emittable EVENTS - These events need to be emitted to send messages
       - `ack` - *(no arguments)*: Tells the request to reset timeout, has no body or data to send
       - `update` - data *string*: Sends a message with data update the request. Also resets the timeout.
       - `response` - err *error|null*, results *object|array|string|buffer*: Sends an error or response to the request
     - Helper Methods - These methods are helper methods to make emitting the events above easier
        - `ack()`: Tells the request to reset timeout, has no body or data to send
        - `update(data *string*)`: Sends a message with data update the request. Also resets the timeout.
        - `response(err *error|null*, results *object|array|string|buffer*)`: Sends an error or response to the request

###### Example:
 ```javascript
 app.nats.handle('lookup', {
		queue: "dns.lookup"
	}, function(msg, handler){
		setTimeout(function(){
			handler.ack();
		}, 2500);
		setTimeout(function(){
			handler.update({
				pending: true
			});
		}, 5000);
		setTimeout(function(){
			handler.response(null, msg);
		}, 7500);
	});
  ```