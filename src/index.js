const WebSocket = require('ws');
const url = require("url");
const EventEmitter = require("events").EventEmitter;
const uid = require('@cocreate/uuid')
const config = require('@cocreate/config')

class SocketServer extends EventEmitter {
    constructor(server, prefix) {
        super();
        this.clients = new Map();
        this.prefix = prefix || "crud";
        config({ organization_id: { prompt: 'Enter your organization_id: ' } })

        this.wss = new WebSocket.Server({ noServer: true });
        this.wss.on('headers', (headers, request) => {
            headers.push('Access-Control-Allow-Origin: *');
        });

        server.on('upgrade', (request, socket, head) => {
            if (!this.handleUpgrade(request, socket, head)) {
                socket.destroy();
            }
        });
    }

    handleUpgrade(req, socket, head) {
        const self = this;
        const pathname = url.parse(req.url).pathname;
        const config = this.getKeyFromUrl(pathname)
        if (config.type == this.prefix) {
            self.wss.handleUpgrade(req, socket, head, function (socket) {
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

        this.send(socket, { method: 'connect', connectedKey: socket.config.key });

    }

    addClient(socket) {
        let organization_id = socket.config.organization_id
        let user_id = socket.config.user_id
        let key = socket.config.key
        let clients = this.clients.get(key);
        if (clients) {
            clients.push(socket);
        } else {
            clients = [socket];
        }
        this.clients.set(key, clients);

        if (user_id)
            this.emit('userStatus', socket, { user_id, userStatus: 'on', organization_id });

        this.emit("createMetrics", {
            organization_id,
            clients: clients.length,
        });
    }

    removeClient(socket) {
        let organization_id = socket.config.organization_id
        let user_id = socket.config.user_id
        let key = socket.config.key
        let clients = this.clients.get(key)
        const index = clients.indexOf(socket);

        if (index > -1) {
            clients.splice(index, 1);
        }

        if (clients.length == 0) {
            if (user_id)
                this.emit('userStatus', socket, { user_id, status: 'off', organization_id });

            // TODO: remove if no one else connected to organization
            this.emit("deleteMetrics", { organization_id });
            this.emit("deleteAuthorized", organization_id);
            this.emit('disconnect', organization_id)
        } else {
            this.emit("updateMetrics", {
                organization_id,
                clients: clients.length
            });
        }

    }

    async onMessage(req, socket, message) {
        try {
            const organization_id = socket.config.organization_id
            let data = JSON.parse(message)

            if (data.method) {
                this.emit("setBandwidth", {
                    type: 'in',
                    data: message,
                    organization_id
                });
                let user_id = null;
                if (this.authenticate)
                    user_id = await this.authenticate.decodeToken(req);

                if (this.authorize) {
                    data.host = this.getHost(req)
                    const authorized = await this.authorize.check(data, user_id)
                    if (authorized.storage === false) {
                        data.database = process.env.organization_id
                        data.organization_id = process.env.organization_id

                        const authorized2 = await this.authorize.check(data, req, user_id)
                        if (!authorized2 || authorized2.error) {
                            return this.send(socket, { method: 'Access Denied', authorized2, ...data })
                        }
                    } else if (!authorized || authorized.error) {
                        if (!user_id)
                            this.send(socket, { method: 'updateUserStatus', userStatus: 'off', clientId: data.clientId, organization_id })

                        return this.send(socket, { method: 'Access Denied', authorized, ...data })
                    }
                    // dburl is true and db does not have 'keys' array
                    // action: syncCollection data{array: 'keys', object[]}
                    // actions: add keys as once keys are added admin user can do anything


                    // }

                    if (authorized.authorized)
                        data = authorized.authorized

                    if (user_id) {
                        if (!socket.config.user_id) {
                            socket.config.user_id = user_id
                            this.emit('userStatus', socket, { method: 'userStatus', user_id, userStatus: 'on', organization_id });
                        }
                    } else {
                        this.send(socket, { method: 'updateUserStatus', userStatus: 'off', clientId: data.clientId, organization_id })
                    }

                    this.emit(data.method, socket, data);

                }
            }
        } catch (e) {
            console.log(e);
        }
    }

    broadcast(socket, data) {
        if (!data.uid)
            data.uid = uid.generate()

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

                this.send(socket, data, url)
            }
        } else {
            this.send(socket, data, url)
        }
    }

    async send(socket, data, url) {
        let clients
        if (!url)
            clients = [socket]
        else
            clients = this.clients.get(url);

        if (clients) {
            for (let client of clients) {
                if (socket != client && data.broadcast != false || socket == client && data.broadcastSender != false) {
                    const authorized = await this.authorize.check(data, socket.config.user_id)
                    if (authorized && authorized.authorized)
                        data = authorized.authorized

                    let responseData = JSON.stringify(data);

                    socket.send(responseData);

                    if (socket.config && socket.config.organization_id)
                        this.emit("setBandwidth", {
                            type: 'out',
                            data: responseData,
                            organization_id: socket.config.organization_id
                        })
                }
            }
        }

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

    getHost(req) {
        const headers = req['headers']
        let origin = headers['origin'];
        if (origin && origin !== 'null')
            return url.parse(origin).hostname;
    }

}


module.exports = SocketServer
