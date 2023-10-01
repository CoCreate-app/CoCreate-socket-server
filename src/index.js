const WebSocket = require('ws');
const { URL } = require("url");
const EventEmitter = require("events").EventEmitter;
const uid = require('@cocreate/uuid')
const config = require('@cocreate/config')

class SocketServer extends EventEmitter {
    constructor(server, prefix) {
        super();
        this.prefix = prefix || "ws";
        this.organizations = new Map();
        this.clients = new Map();
        this.sockets = new Map();
        this.users = new Map();

        config({ organization_id: { prompt: 'Enter your organization_id: ' } })

        this.wss = new WebSocket.Server({ noServer: true });

        this.wss.on('headers', (headers, request) => {
            headers.push('Access-Control-Allow-Origin: *');
        });

        this.wss.on('error', (error) => {
            socket.destroy();
        });

        server.on('upgrade', (request, socket, head) => {
            const self = this;
            const config = this.getKeyFromUrl(request.url)
            if (config.type == this.prefix && config.organization_id) {
                this.wss.handleUpgrade(request, socket, head, function (socket) {
                    socket.config = config
                    socket.organization_id = config.organization_id
                    socket.origin = request.headers.origin
                    socket.pathname = request.url

                    if (socket.origin && socket.origin !== 'null') {
                        const url = new URL(socket.origin);
                        socket.host = url.host;
                    }

                    self.onWebSocket(socket);
                })
            }
        });
    }

    onWebSocket(socket) {
        const self = this;
        socket.on('message', async (message) => {
            self.onMessage(socket, message);
        })

        socket.on('close', () => {
            self.delete(socket)
        })

        socket.on("error", () => {
            self.delete(socket)
        });

        socket.send(JSON.stringify({ method: 'connect', connectedKey: socket.config.key }))

    }

    add(socket) {
        // TODO: query db for messages from a specified date
        let organization_id = socket.organization_id

        let organization = this.organizations.get(organization_id)
        if (!organization) {
            organization = {
                status: true,
                clients: {}
            }
            this.organizations.set(organization_id, organization)
        }

        if (!this.clients.has(socket.clientId)) {
            this.clients.set(socket.clientId, []);
            organization.clients[socket.clientId] = []
        }

        if (!this.sockets.has(socket.id)) {
            this.sockets.set(socket.id, socket);
            this.clients.get(socket.clientId).push(socket);
            organization.clients[socket.clientId].push(socket)
        }

        if (socket.user_id) {
            this.emit('userStatus', { socket, user_id: socket.user_id, userStatus: 'on', organization_id });

            if (!this.users.has(socket.user_id)) {
                this.users.set(socket.user_id, [socket])
            } else {
                this.users.get(socket.user_id).push(socket)
            }
        }

    }

    get(data) {
        let sockets = []
        if (data.broadcast !== false) {
            let clients = this.organizations.get(data.organization_id).clients
            if (clients) {
                for (let client of Object.keys(clients)) {
                    if (data.broadcastSender === false && client === data.clientId) continue

                    if (data.broadcastClient)
                        sockets.push(clients[client][0])
                    else
                        sockets.push(...clients[client])
                }
            }
        } else if (data.broadcastSender) {
            sockets.push(data.socket)
        }
        return sockets
    }

    delete(socket) {
        let organization_id = socket.organization_id
        if (this.organizations.has(organization_id)) {
            const clients = this.organizations.get(organization_id).clients;

            // Check if the client exists
            if (clients && clients[socket.clientId]) {
                const client = clients[socket.clientId]

                // Check if the socket exists in the client's sockets
                const index = client.findIndex(item => item.id === socket.id);
                if (index !== -1) {
                    client.splice(index, 1);
                }

                // Delete the client if it's empty
                if (!client.length) {
                    delete clients[socket.clientId];
                }

                if (!Object.keys(clients).length) {
                    this.organizations.delete(socket.organization_id);
                }

            }
        }

        if (this.clients.has(socket.clientId)) {
            const client = this.clients.get(socket.clientId)
            const index = client.findIndex(item => item.id === socket.id);
            if (index !== -1) {
                client.splice(index, 1);
            }

            if (!client.length) {
                this.clients.delete(socket.clientId);
            }
        }

        if (this.clients.size === 0) {
            this.organizations.delete(socket.organization_id);
        }

        this.sockets.delete(socket.id);

        if (socket.user_id) {
            let sockets = this.users.get(socket.user_id)
            if (sockets) {
                const index = sockets.findIndex(item => item.id === socket.id);
                if (index !== -1) {
                    sockets.splice(index, 1);
                }
                if (!sockets.length) {
                    this.users.delete(socket.user_id);
                    this.emit('userStatus', { socket, user_id, status: 'off', organization_id });
                }
            }
        }
    }

    async onMessage(socket, message) {
        try {
            const organization_id = socket.organization_id

            this.emit("setBandwidth", {
                type: 'in',
                data: message,
                organization_id
            });

            if (this.organizations.has(organization_id) && !this.organizations.get(organization_id).status)
                return this.send({ socket, method: 'Access Denied', balance: 'Your balance has fallen bellow 0' })

            let data = JSON.parse(message)
            if (data.method) {
                let user_id = null;
                console.log('socket.protocol: ', socket.protocol)
                if (this.authenticate)
                    user_id = await this.authenticate.decodeToken(socket.protocol);

                if (this.authorize) {
                    if (!socket.id && data.socketId)
                        socket.id = data.socketId;
                    if (!socket.clientId && data.clientId)
                        socket.clientId = data.clientId;
                    if (!socket.user_id && user_id) {
                        socket.user_id = user_id;
                        this.emit('userStatus', { socket, method: 'userStatus', user_id, userStatus: 'on', organization_id });
                    }

                    if (!this.sockets.has(socket.id)) {
                        this.add(socket);
                        if (!this.organizations.get(organization_id).status)
                            return this.send({ socket, method: 'Access Denied', balance: 'Your balance has fallen bellow 0' })
                    }

                    data.socket = socket

                    const authorized = await this.authorize.check(data, user_id)
                    if (authorized.storage === false) {
                        data.database = process.env.organization_id
                        data.organization_id = process.env.organization_id

                        const authorized2 = await this.authorize.check(data, req, user_id)
                        if (!authorized2 || authorized2.error) {
                            return this.send({ socket, method: 'Access Denied', authorized2, ...data })
                        }
                    } else if (!authorized || authorized.error) {
                        if (!user_id)
                            this.send({ socket, method: 'updateUserStatus', userStatus: 'off', socketId: data.socketId, organization_id })

                        return this.send({ socket, method: 'Access Denied', authorized, ...data })
                    }
                    // dburl is true and db does not have 'keys' array
                    // action: syncCollection data{array: 'keys', object[]}
                    // actions: add keys as once keys are added admin user can do anything


                    // }

                    if (authorized.authorized)
                        data = authorized.authorized

                    this.emit(data.method, data);

                }
            }
        } catch (e) {
            console.log(e);
        }
    }

    async send(data) {
        // const socket = this.sockets.get(data.socketId)
        const socket = data.socket
        // TODO: store a list of sent clients so that we can exclude for push notification clients

        const authorized = await this.authorize.check(data, socket.user_id)
        if (authorized && authorized.authorized)
            data = authorized.authorized

        if (!data.uid)
            data.uid = uid.generate()

        if (!data.method.startsWith('read.') || data.log)
            this.emit('create.object', {
                method: 'create.object',
                array: 'message_log',
                object: data,
                organization_id: data.organization_id
            });

        let sockets = this.get(data);

        delete data.socket

        for (let i = 0; i < sockets.length; i++) {
            const authorized = await this.authorize.check(data, sockets[i].user_id)
            if (authorized && authorized.authorized)
                sockets[i].send(JSON.stringify(authorized.authorized));
            else
                sockets[i].send(JSON.stringify(data));

            this.emit("setBandwidth", {
                type: 'out',
                data: authorized.authorized,
                organization_id: socket.organization_id
            })
        }

        // TODO: send message to notification with an array of clientId so that notification can send to subscribed clients that message was not already sent to
    }

    getKeyFromUrl(pathname) {
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

}

module.exports = SocketServer
