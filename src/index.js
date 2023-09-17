const WebSocket = require('ws');
const { URL } = require("url");
const EventEmitter = require("events").EventEmitter;
const uid = require('@cocreate/uuid')
const config = require('@cocreate/config')

class SocketServer extends EventEmitter {
    constructor(server, prefix) {
        super();
        this.organizations = new Map();
        this.clients = new Map();
        this.prefix = prefix || "ws";
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
        // const url = new URL(req.url);
        // const pathname = req.url;
        const config = this.getKeyFromUrl(req.url)
        if (config.type == this.prefix) {
            this.wss.handleUpgrade(req, socket, head, function (socket) {
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

        this.send(socket, { socket, method: 'connect', connectedKey: socket.config.key });

    }

    addClient(socket) {
        let organization_id = socket.config.organization_id
        if (!this.organizations.has(organization_id))
            this.organizations.set(organization_id, true)

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
            this.emit('userStatus', socket, { socket, user_id, userStatus: 'on', organization_id });
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

        if (user_id)
            this.emit('userStatus', socket, { socket, user_id, status: 'off', organization_id });

        if (clients.length == 0) {
            this.organizations.delete(organization_id)
            this.emit('disconnect', organization_id)
        }

    }

    async onMessage(req, socket, message) {
        try {
            const organization_id = socket.config.organization_id

            this.emit("setBandwidth", {
                type: 'in',
                data: message,
                organization_id
            });

            let active = this.organizations.get(organization_id)
            if (active === false)
                return this.send({ socket, method: 'Access Denied', balance: 'Your balance has fallen bellow 0' })

            let data = JSON.parse(message)

            if (data.method) {
                let user_id = null;
                if (this.authenticate)
                    user_id = await this.authenticate.decodeToken(req);

                if (this.authorize) {
                    data.socket = socket

                    data.host = this.getHost(req)
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
                            this.send({ socket, method: 'updateUserStatus', userStatus: 'off', clientId: data.clientId, organization_id })

                        return this.send({ method: 'Access Denied', authorized, ...data })
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
                            this.emit('userStatus', { socket, method: 'userStatus', user_id, userStatus: 'on', organization_id });
                        }
                    } else {
                        this.send({ socket, method: 'updateUserStatus', userStatus: 'off', clientId: data.clientId, organization_id })
                    }

                    this.emit(data.method, data);

                }
            }
        } catch (e) {
            console.log(e);
        }
    }

    broadcast(data) {
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

                this.send(data, url)
            }
        } else {
            this.send(data, url)
        }
    }

    async send(data, url) {
        const socket = data.socket
        delete data.socket

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
                    client.send(responseData);

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
        if (req.headers.origin && req.headers.origin !== 'null') {
            const url = new URL(req.headers.origin);
            return url.host;
        } else if (req.headers.host && req.headers.host !== 'null') {
            return req.headers.host;
        }
    }

}

module.exports = SocketServer
