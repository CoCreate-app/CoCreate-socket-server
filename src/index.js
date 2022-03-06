
const qs = require('querystring');
const WebSocket = require('ws');
const url = require("url");
const EventEmitter = require("events").EventEmitter;
const AsyncMessage = require("./AsyncMessage")
const CoCreateUUID = require('@cocreate/uuid')

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
		const url_info = this.getKeyFromUrl(pathname)
		if (url_info.type == this.prefix) {
			self.wss.handleUpgrade(req, socket, head, function(socket) {
				self.onWebSocket(req, socket, url_info);
			})
			return true;
		}
		return false;
	}
	
	onWebSocket(req, socket, info) {
		const self = this;
		
		this.addClient(socket, info.key, info);

		socket.on('message', async (message) => {
			await self.onMessage(req, socket, message, info);
		})
		
		socket.on('close', function () {
			self.removeClient(socket, info.key, info)
		})

		socket.on("error", () => {
			self.removeClient(socket, info.key, info)
		});
		
		this.send(socket, 'connect', info.key);
		
	}
	
	removeClient(socket, key, roomInfo) {
		let room_clients = this.clients.get(key)
		const index = room_clients.indexOf(socket);

		if (index > -1) {
			room_clients.splice(index, 1);
		}
		
		if (room_clients.length == 0) {
			this.emit('userStatus', socket, {info: key.replace(`/${this.prefix}/`, ''), status: 'off'}, roomInfo);
			this.emit("removeMetrics", null, { org_id: roomInfo.orgId });
			// this.addAsyncMessage.delete(key);
		} else {
			let total_cnt = 0;
			this.clients.forEach((c) => total_cnt += c.length)
			
			this.emit("changeCountMetrics", null, {
				org_id: roomInfo.orgId, 
				total_cnt, 
				client_cnt: room_clients.length
			});
		}
		
	}
	
	addClient(socket, key, roomInfo) {
		let room_clients = this.clients.get(key);
		if (room_clients) {
			room_clients.push(socket);
		} else {
			room_clients = [socket];
		}
		this.clients.set(key, room_clients);
		this.addAsyncMessage(roomInfo.key)
		
		this.emit('userStatus', socket, {info: key.replace(`/${this.prefix}/`, ''), status: 'on'}, roomInfo);

		//. add metrics
		let total_cnt = 0;
		this.clients.forEach((c) => total_cnt += c.length)
		
		this.emit("createMetrics", null, {
			org_id: roomInfo.orgId, 
			client_cnt: room_clients.length, 
			total_cnt: total_cnt
		});
	}
	
	addAsyncMessage(key) {
		let asyncMessage = this.asyncMessages.get(key)
		if (!asyncMessage) {
			this.asyncMessages.set(key, new AsyncMessage(key));
		}
	}
	
	getKeyFromUrl(pathname)	{
		var path = pathname.split("/");
		var params = {
			type: null,
			key: pathname
		}  
		if (path.length > 0) {
			params.type = path[1];
			params.orgId = path[2]
		}
		return params
	}
	
	async onMessage(req, socket, message, roomInfo) {
		try {
			this.recordTransfer('in', message, roomInfo.orgId)
			
			// ToDo remove
			if (message instanceof Buffer) {
				this.emit('importFile2DB', socket, message, roomInfo);
				console.log('importFile2DB', socket, message, roomInfo);
				return;
			}
			
			const requestData = JSON.parse(message)
			let cloneRoomInfo = {...roomInfo};

			if (requestData.module) {
				let user_id = null;
				if (this.authInstance) {
					user_id = await this.authInstance.getUserId(req);
				}

				//. check permission
				if (this.permissionInstance) {
					let passStatus = await this.permissionInstance.check(requestData.module, requestData.data, req, user_id)
					if (!passStatus) {
						this.send(socket, 'permissionError', requestData.data, cloneRoomInfo.orgId, cloneRoomInfo)
						return;
					}
				}
				
				//. checking async status....				
				if (requestData.data.async == true) {
					const uuid = CoCreateUUID.generate(), asyncMessage = this.asyncMessages.get(cloneRoomInfo.key);
					cloneRoomInfo.asyncId = uuid;
					if (asyncMessage) {
						asyncMessage.defineMessage(uuid);
					}
				}
				this.emit(requestData.module, socket, requestData.data, cloneRoomInfo);
			}
			
		} catch(e) {
			console.log(e);
		}
	}
	
	broadcast(socket, namespace, rooms, messageType, data, roomInfo) {
		const self = this;
		const asyncId = this.getAsyncId(roomInfo)
	    let room_key = `/${this.prefix}/${namespace}`;
	    const responseData =JSON.stringify({
			module: messageType,
			data: data
		});
		
		let isAsync = false;
		let asyncData = [];
		if (asyncId && roomInfo && roomInfo.key) {
			isAsync = true;	
		}

		if (rooms) {
			if (!rooms.isArray())
				rooms = [rooms]
			for (let room of rooms) {
				room_key += `/${room}`;	
				const clients = this.clients.get(room_key);

				if (clients) {
					clients.forEach((client) => {
						if (socket != client || socket == client && data.broadcast_sender != false) {
							if (isAsync) {
								asyncData.push({socket: client, message: responseData})
							} else {
								client.send(responseData);
							}
							self.recordTransfer('out', responseData, namespace)
						}
					})
				}
			}
			
		} else {
			this.clients.forEach((value, key) => {
				console.log(value.length, key)
				if (key.includes(room_key)) {
					value.forEach(client => {
						if (socket != client || socket == client && data.broadcast_sender != false) {
							if (isAsync) {
								asyncData.push({socket: client, message: responseData})
							} else {
								client.send(responseData);
							}
							self.recordTransfer('out', responseData, namespace)
						}
					})
				}
			})
		}
		
		//. set async processing
		if (isAsync) {
			this.asyncMessages.get(roomInfo.key).setMessage(asyncId, asyncData)
		}
		
	}
	
	send(socket, messageType, data, orgId, roomInfo){
		const asyncId = this.getAsyncId(roomInfo)
		let responseData = JSON.stringify({
			module: messageType,
			data: data
		});

		if (asyncId && roomInfo && roomInfo.key) {
			this.asyncMessages.get(roomInfo.key).setMessage(asyncId, [{socket, message: responseData}]);
		} else {
			socket.send(responseData);
		}
		this.recordTransfer('out', responseData, orgId)

	}
	
	getAsyncId(roomInfo) {
		if (!roomInfo) return null;
		
		if (roomInfo.asyncId) {
			return roomInfo.asyncId;
		}
		return null
	}
	
	sendBinary(socket, data, orgId) {
		socket.send(data, {binary: true});
		this.recordTransfer('out', data, orgId)
	}
	
	recordTransfer(type, data, org_id) {
		this.emit("setBandwidth", null, {
			type, 
			data, 
			org_id
		});
		
		// let date = new Date();
		// let size = 0;
		
		// type = type || 'in'
		
		// if (data instanceof Buffer) {
		// 	size = data.byteLength;
		// } else if (data instanceof String || typeof data === 'string') {
		// 	size = Buffer.byteLength(data, 'utf8');
		// }
		
		// if (size > 0 && orgId) {
		// 	console.log (`${orgId}  ----  ${type} \t ${date.toISOString()} \t ${size}`);
		// }
	}
}


module.exports = SocketServer
