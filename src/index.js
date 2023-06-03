const WebSocket = require('ws');
const url = require("url");
const EventEmitter = require("events").EventEmitter;
const uid = require('@cocreate/uuid')

class SocketServer extends EventEmitter {
    constructor(prefix) {
        super();
        this.clients = new Map();
        this.prefix = prefix || "crud";
        this.wss = new WebSocket.Server({ noServer: true });
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

        this.send(socket, 'connect', socket.config.key);

    }

    addClient(socket) {
        let organization_id = socket.config.organization_id
        let user_id = socket.config.user_id
        let key = socket.config.key
        let room_clients = this.clients.get(key);
        if (room_clients) {
            room_clients.push(socket);
        } else {
            room_clients = [socket];
        }
        this.clients.set(key, room_clients);

        if (user_id)
            this.emit('userStatus', socket, { user_id, userStatus: 'on', organization_id });

        //. add metrics
        let total_cnt = 0;
        this.clients.forEach((c) => total_cnt += c.length)

        this.emit("createMetrics", {
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
                this.emit('userStatus', socket, { user_id, status: 'off', organization_id });

            // TODO: remove if no one else connected to organization
            this.emit("deleteMetrics", { organization_id });
            this.emit("deletePermissions", organization_id);
            this.emit('disconnect', organization_id)
        } else {
            let total_cnt = 0;
            this.clients.forEach((c) => total_cnt += c.length)

            this.emit("changeCountMetrics", {
                organization_id,
                total_cnt,
                client_cnt: room_clients.length
            });
        }

    }

    async onMessage(req, socket, message) {
        try {
            const organization_id = socket.config.organization_id
            let { action, data } = JSON.parse(message)

            if (action) {
                this.emit("setBandwidth", {
                    type: 'in',
                    data: message,
                    organization_id
                });
                let user_id = null;
                if (this.authenticate)
                    user_id = await this.authenticate.getUserId(req);

                if (this.authorize) {
                    data.host = this.getHost(req)
                    const permission = await this.authorize.check(action, data, user_id)
                    if (permission.dbUrl === false) {
                        data.database = process.env.organization_id
                        data.organization_id = process.env.organization_id

                        const permission2 = await this.authorize.check(action, data, req, user_id)
                        if (!permission2 || permission2.error) {
                            return this.send(socket, 'Access Denied', { action, permission2, ...data })
                        }
                    } else if (!permission || permission.error) {
                        if (!user_id)
                            this.send(socket, 'updateUserStatus', { userStatus: 'off', clientId: data.clientId, organization_id })

                        return this.send(socket, 'Access Denied', { action, permission, ...data })
                    }
                    // dburl is true and db does not have 'keys' collection
                    // action: syncCollection data{collection: 'keys', document[]}
                    // actions: add keys as once keys are added admin user can do anything


                    // }

                    if (permission.authorized)
                        data = permission.authorized

                    if (user_id) {
                        if (!socket.config.user_id) {
                            socket.config.user_id = user_id
                            this.emit('userStatus', socket, { user_id, userStatus: 'on', organization_id });
                        }
                    } else {
                        this.send(socket, 'updateUserStatus', { userStatus: 'off', clientId: data.clientId, organization_id })
                    }

                    this.emit(action, socket, data);

                }
            }
        } catch (e) {
            console.log(e);
        }
    }

    broadcast(socket, action, data) {
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

                this.send(socket, action, data, url)
            }
        } else {
            this.send(socket, action, data, url)
        }
    }

    async send(socket, action, data, url) {
        let clients
        if (!url)
            clients = [socket]
        else
            clients = this.clients.get(url);

        if (clients) {
            for (let client of clients) {
                if (socket != client && data.broadcast != false || socket == client && data.broadcastSender != false) {
                    const permission = await this.authorize.check(action, data, socket.config.user_id)
                    if (permission && permission.authorized)
                        data = permission.authorized

                    let responseData = JSON.stringify({
                        action,
                        data
                    });

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
