const WebSocket = require('ws');
const url = require("url");
const EventEmitter = require("events").EventEmitter;
const AsyncMessage = require("./AsyncMessage")
const uid = require('@cocreate/uuid')

class SocketServer extends EventEmitter{
	constructor(prefix) {
		super();

		this.clients = new Map();
		this.asyncMessages = new Map();
		
		this.prefix = prefix || "crud";
		
		//. websocket server
		this.wss = new WebSocket.Server({noServer: true});
		this.permissionInstance = null;
		this.authInstance = null;
	}
	
	setPermission(instance) {
		this.permissionInstance = instance;
	}
	
	setAuth(instance) {
		this.authInstance = instance
	}
	
	handleUpgrade(req, socket, head) {
		const self = this;
		const pathname = url.parse(req.url).pathname;
		const config = this.getKeyFromUrl(pathname)
		if (config.type == this.prefix) {
			self.wss.handleUpgrade(req, socket, head, function(socket) {
				socket.config = config
				self.onWebSocket(req, socket);
			})
			return true;
		}
		return false;
	}
	
	onWebSocket(req, socket) {
		const self = this;
		
		this.addClient(socket);

		socket.on('message', async (message) => {
			self.onMessage(req, socket, message);
		})
		
		socket.on('close', function () {
			self.removeClient(socket)
		})

		socket.on("error", () => {
			self.removeClient(socket)
		});
		
		this.send(socket, 'connect', socket.config.key);
		
	}
	
	addClient(socket) {
		let organization_id = socket.config.organization_id
		let key = socket.config.key
		let room_clients = this.clients.get(key);
		if (room_clients) {
			room_clients.push(socket);
		} else {
			room_clients = [socket];
		}
		this.clients.set(key, room_clients);
		// this.addAsyncMessage(key)

		let asyncMessage = this.asyncMessages.get(key)
		if (!asyncMessage) {
			this.asyncMessages.set(key, new AsyncMessage(key));
		}
		
		//. add metrics
		let total_cnt = 0;
		this.clients.forEach((c) => total_cnt += c.length)
		
		this.emit("createMetrics", null, {
			organization_id, 
			client_cnt: room_clients.length, 
			total_cnt: total_cnt
		});
	}
	
	removeClient(socket) {
		let organization_id = socket.config.organization_id
		let user_id = socket.config.user_id
		let key = socket.config.key
		let room_clients = this.clients.get(key)
		const index = room_clients.indexOf(socket);

		if (index > -1) {
			room_clients.splice(index, 1);
		}
		
		if (room_clients.length == 0) {
			if (user_id)
				this.emit('userStatus', socket, {user_id, status: 'off', organization_id});
			
			this.emit("removeMetrics", null, { organization_id });

			this.asyncMessages.delete(key);
		} else {
			let total_cnt = 0;
			this.clients.forEach((c) => total_cnt += c.length)
			
			this.emit("changeCountMetrics", null, {
				organization_id, 
				total_cnt, 
				client_cnt: room_clients.length
			});
		}
		
	}
		
	async onMessage(req, socket, message) {
		try {
			const organization_id = socket.config.organization_id
			
			// ToDo: remove
			// if (message instanceof Buffer) {
			// 	this.emit('importFile2DB', socket, message);
			// 	console.log('importFile2DB', socket, message);
			// 	return;
			// }
			
			const {action, data} = JSON.parse(message)

			if (action) {
				this.recordTransfer('in', message, organization_id)

				let user_id = null;
				if (this.authInstance)
					user_id = await this.authInstance.getUserId(req);
				
				//. check permission
				if (this.permissionInstance) {
					const passStatus = await this.permissionInstance.check(action, data, req, user_id)
					if (passStatus !== true) {
						// if (action == 'syncServer' && passStatus.database === true)
						// if (action == 'syncServer')
						// 	this.emit('createDocument', socket, data);
						// else
							this.send(socket, 'Access Denied', passStatus)
						return;
					}
				}

				if (user_id) {
					if (!socket.config.user_id ) {
						socket.config.user_id = user_id
					}
					this.emit('userStatus', socket, {user_id, userStatus: 'on', organization_id});
				}

				//. checking async status....				
				if (data.async == true) {
					console.log('async true')
					const asyncMessage = this.asyncMessages.get(socket.config.key);
					socket.config.asyncId = uid.generate();
					if (asyncMessage) {
						asyncMessage.defineMessage(socket.config.asyncId);
					}
				}

				this.emit(action, socket, data);
			}
			
		} catch(e) {
			console.log(e);
		}
	}
	
	broadcast(socket, action, data) {
		const self = this;
		if (!data.uid)
			data.uid = uid.generate()
		const responseData = JSON.stringify({
			action,
			data
		});

		const asyncId = socket.config.asyncId
		let isAsync = false;
		let asyncData = [];
		if (asyncId && socket.config && socket.config.key) {
			isAsync = true;	
		}

		let organization_id = socket.config.organization_id;
	    let url = `/${this.prefix}/${organization_id}`;
		
		let namespace = data.namespace;
		if (namespace) {
			url += `/${namespace}`
		}

		let rooms = data.room;
		if (rooms) {
			if (!rooms.isArray())
				rooms = [rooms]
			for (let room of rooms) {
				let url = url;
				url += `/${room}`;	
				const clients = this.clients.get(url);

				if (clients) {
					clients.forEach((client) => {
						if (socket != client  && data.broadcast != false || socket == client && data.broadcastSender != false) {
							if (isAsync) {
								asyncData.push({socket: client, message: responseData})
							} else {
								client.send(responseData);
							}
							self.recordTransfer('out', responseData, organization_id)
						}
					})
				}
			}
			
		} else {
			this.clients.forEach((value, key) => {
				if (key.includes(url)) {
					value.forEach(client => {
						if (socket != client  && data.broadcast != false || socket == client && data.broadcastSender != false) {
							if (isAsync) {
								asyncData.push({socket: client, message: responseData})
							} else {
								client.send(responseData);
							}
							self.recordTransfer('out', responseData, organization_id)
						}
					})
				}
			})
		}
		
		//. set async processing
		if (isAsync) {
			this.asyncMessages.get(socket.config.key).setMessage(asyncId, asyncData)
		}
		
	}
	
	send(socket, action, data){
		const asyncId = socket.config.asyncId
		let responseData = JSON.stringify({
			action,
			data
		});

		if (asyncId && socket.config && socket.config.key) {
			this.asyncMessages.get(socket.config.key).setMessage(asyncId, [{socket, message: responseData}]);
		} else {
			socket.send(responseData);
		}

		if (socket.config && socket.config.organization_id)
			this.recordTransfer('out', responseData, socket.config.organization_id)

	}

	// addAsyncMessage(key) {
	// 	let asyncMessage = this.asyncMessages.get(key)
	// 	if (!asyncMessage) {
	// 		this.asyncMessages.set(key, new AsyncMessage(key));
	// 	}
	// }
	
	getKeyFromUrl(pathname)	{
		var path = pathname.split("/");
		var params = {
			type: null,
			key: pathname
		}  
		if (path.length > 0) {
			params.type = path[1];
			params.organization_id = path[2]
		}
		return params
	}

		
	sendBinary(socket, data, organization_id) {
		socket.send(data, {binary: true});
		this.recordTransfer('out', data, organization_id)
	}
	
	recordTransfer(type, data, organization_id) {
		this.emit("setBandwidth", null, {
			type, 
			data, 
			organization_id
		});
		
		// let date = new Date();
		// let size = 0;
		
		// type = type || 'in'
		
		// if (data instanceof Buffer) {
		// 	size = data.byteLength;
		// } else if (data instanceof String || typeof data === 'string') {
		// 	size = Buffer.byteLength(data, 'utf8');
		// }
		
		// if (size > 0 && organization_id) {
		// 	console.log (`${organization_id}  ----  ${type} \t ${date.toISOString()} \t ${size}`);
		// }
	}
}


module.exports = SocketServer
