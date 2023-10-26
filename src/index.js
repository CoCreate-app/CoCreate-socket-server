const WebSocket = require('ws');
const { URL } = require("url");
const EventEmitter = require("events").EventEmitter;
const uid = require('@cocreate/uuid')
const config = require('@cocreate/config')

class SocketServer extends EventEmitter {
    constructor(server) {
        super();
        this.serverId = uid.generate(12)
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
            let organization_id = request.url.split('/')
            organization_id = organization_id[organization_id.length - 1]

            this.wss.handleUpgrade(request, socket, head, function (socket) {
                if (organization_id) {
                    let organization = self.organizations.get(organization_id)
                    if (organization && organization.status === false) {
                        let errors = {}
                        errors.serverOrganization = organization.serverOrganization
                        errors.serverStorage = organization.serverStorage
                        errors.organizationBalance = organization.organizationBalance
                        errors.error = organization.error
                        return socket.send(JSON.stringify({ method: 'Access Denied', error: errors }))
                    }

                    let options = decodeURIComponent(request.headers['sec-websocket-protocol'])
                    options = JSON.parse(options)

                    socket.organization_id = organization_id
                    socket.id = options.socketId;
                    socket.clientId = options.clientId;
                    socket.pathname = request.url
                    socket.origin = request.headers.origin || request.headers.host

                    if (socket.origin.startsWith('http'))
                        socket.origin = socket.origin.replace('http', 'ws')

                    socket.socketUrl = socket.origin + socket.pathname

                    if (socket.origin && socket.origin !== 'null') {
                        const url = new URL(socket.origin);
                        socket.host = url.host || socket.origin;
                    }

                    if (!organization || organization && organization.status !== false) {
                        let data = {
                            socket,
                            method: 'read.object',
                            array: 'message_log',
                            $filter: {
                                sort: [
                                    { key: '_id', direction: 'desc' }
                                ]
                            },
                            sync: true,
                            organization_id
                        }

                        if (options.lastSynced)
                            data.$filter.query = [
                                { key: '_id', value: options.lastSynced, operator: '$gt' }
                            ]
                        else
                            data.$filter.limit = 1

                        self.emit('read.object', data);

                        if (self.authenticate) {
                            const { user_id, expires } = self.authenticate.decodeToken(options.token)
                            const userStatus = { socket, method: 'userStatus', user_id: options.user_id, userStatus: 'off', organization_id }
                            if (user_id) {
                                options.user_id = user_id
                                socket.user_id = user_id;
                                socket.expires = expires;
                                userStatus.userStatus = 'on'
                                self.emit("notification.user", socket)
                            }

                            self.emit('userStatus', userStatus);

                            self.onWebSocket(socket);

                        } else
                            self.onWebSocket(socket);
                    }

                } else {
                    socket.send(JSON.stringify({ method: 'Access Denied', error: 'An organization_id is required' }))
                }
            })
        });
    }

    onWebSocket(socket) {
        const self = this;
        this.add(socket);

        socket.on('message', async (message) => {
            self.onMessage(socket, message);
        })

        socket.on('close', () => {
            self.delete(socket)
        })

        socket.on("error", () => {
            self.delete(socket)
        });

        socket.send(JSON.stringify({ method: 'connect', connectedKey: socket.pathname }))

    }

    add(socket) {
        let organization_id = socket.organization_id

        let organization = this.organizations.get(organization_id)
        if (!organization) {
            organization = {
                status: true,
                clients: {}
            }

            this.organizations.set(organization_id, organization)

            this.emit('update.object', {
                method: 'update.object',
                array: 'organizations',
                object: {
                    _id: organization_id, ['$push.activeHost']: socket.socketUrl // needs socketId
                },
                organization_id
            });

            this.emit('mesh.create', {
                url: socket.socketUrl,
                organization_id
            });

        } else
            clearTimeout(organization.debounce);


        if (!this.clients.has(socket.clientId)) {
            this.clients.set(socket.clientId, []);

            if (!organization.clients)
                organization.clients = { [socket.clientId]: [] }
            else
                organization.clients[socket.clientId] = []
        }

        if (!this.sockets.has(socket.id)) {
            this.sockets.set(socket.id, socket);
            this.clients.get(socket.clientId).push(socket);
            if (!organization.clients[socket.clientId])
                organization.clients[socket.clientId] = [socket]
            else
                organization.clients[socket.clientId].push(socket)
        }

        if (socket.user_id) {
            this.emit('userStatus', { socket, user_id: socket.user_id, userStatus: 'on', organization_id });
            let user = this.users.get(socket.user_id)

            if (!Array.isArray(user)) {
                clearTimeout(user)
                this.users.set(socket.user_id, [socket])
            } else
                user.push(socket)
        }

    }

    get(data) {
        let sockets = []
        if (data.broadcast !== false) {
            let organization = this.organizations.get(data.organization_id)
            if (organization) {
                const clients = organization.clients
                for (let client of Object.keys(clients)) {
                    if (data.broadcastSender === false && client === data.clientId) continue

                    if (data.broadcastClient)
                        sockets.push(clients[client][0])
                    else
                        sockets.push(...clients[client])
                }
            }
        } else if (data.broadcastSender !== false) {
            sockets.push(data.socket)
        }
        return sockets
    }

    delete(socket) {
        let organization_id = socket.organization_id
        if (this.organizations.has(organization_id)) {
            let clients = this.organizations.get(organization_id)
            if (clients)
                clients.clients;
            // Check if the client exists
            if (clients && clients[socket.clientId]) {
                const client = clients[socket.clientId]

                // Check if the socket exists in the client's sockets
                const index = client.findIndex(item => item.id === socket.id);
                if (index !== -1) {
                    client.splice(index, 1);
                }

                if (!client.length) {
                    delete clients[socket.clientId];
                }

                if (!Object.keys(clients).length) {
                    this.organizations.delete(socket.organization_id);
                    this.emit('update.object', {
                        method: 'update.object',
                        array: 'organizations',
                        object: {
                            _id: organization_id, ['$pull.activeHost']: socket.socketUrl
                        },
                        organization_id
                    });

                    this.emit('mesh.update', {
                        url: socket.socketUrl,
                        organization_id
                    });
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
            let organization = this.organizations.get(socket.organization_id)
            let debounceTimer
            if (organization)
                debounceTimer = organization.debounce

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                this.organizations.delete(socket.organization_id);
            }, 10000);

            if (!organization)
                this.organizations.set(socket.organization_id, { debounce: debounceTimer })
            else
                organization.debounce = debounceTimer

            this.sockets.delete(socket.id);

            if (socket.user_id) {
                let sockets = this.users.get(socket.user_id)
                if (sockets) {
                    if (Array.isArray(sockets) && sockets.length) {
                        const index = sockets.findIndex(item => item.id === socket.id);
                        if (index !== -1) {
                            sockets.splice(index, 1);
                        }
                    } else {
                        let userDebounceTimer = sockets

                        clearTimeout(userDebounceTimer);
                        userDebounceTimer = setTimeout(() => {
                            this.users.delete(socket.user_id);
                            this.emit('userStatus', { socket, user_id: socket.user_id, userStatus: 'off', organization_id });
                        }, 10000);

                        this.users.set(socket.user_id, userDebounceTimer)

                    }
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


            let data = JSON.parse(message)
            if (data.method) {
                const organization = this.organizations.get(organization_id)
                if (organization && organization.organizationBalance == false) {
                    data.organizationBalance = false
                    data.error = organization.error
                    return socket.send(JSON.stringify(data))
                }

                if (data.method === 'region.added' || data.method === 'region.removed')
                    console.log('data.method: ', data.method)

                if (socket.user_id && socket.expires && new Date().getTime() >= socket.expires) {
                    socket.user_id = socket.expires = null
                    this.send({ socket, method: 'updateUserStatus', userStatus: 'off', socketId: data.socketId, organization_id })
                }

                if (this.authorize) {
                    if (!this.sockets.has(socket.id)) {
                        if (organization && organization.organizationBalance == false) {
                            data.organizationBalance = false
                            data.error = organization.error
                            return socket.send(JSON.stringify(data))
                        }
                    }

                    data.socket = socket

                    const authorized = await this.authorize.check(data, socket.user_id)
                    let errors = {}
                    if (authorized.serverOrganization === false) {
                        organization.status = errors.status = false;
                        organization.serverOrganization = false;
                        organization.error = authorized.error
                    } else if (authorized.serverStorage === false) {
                        data.database = process.env.organization_id
                        data.organization_id = process.env.organization_id

                        const authorized2 = await this.authorize.check(data, req, socket.user_id)
                        if (!authorized2 || authorized2.error) {
                            organization.status = errors.status = false;
                            organization.error = errors.error = authorized.error
                            if (authorized2.serverOrganization === false) {
                                organization.serverOrganization = false;
                            }
                            if (authorized2.serverStorage === false) {
                                organization.serverStorage = false;
                            }
                        }
                    } else if (authorized.error) {
                        organization.status = false;
                        organization.error = authorized.error
                    }

                    if (organization && organization.status === false) {
                        let errors = {}
                        data.serverOrganization = organization.serverOrganization
                        data.serverStorage = organization.serverStorage
                        data.organizationBalance = organization.organizationBalance
                        data.error = organization.error
                        delete data.socket
                        return socket.send(JSON.stringify(data))
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

        if (data.sync) {
            if (!data.object || !data.object.length)
                return

            for (let i = 0; i < data.object.length; i++) {
                data.object[i].data._id = data.object[i]._id
                data.object[i].data.sync = true

                const authorized = await this.authorize.check(data.object[i].data, socket.user_id)
                if (authorized && authorized.authorized)
                    socket.send(JSON.stringify(authorized.authorized));
                else
                    socket.send(JSON.stringify(data.object[i].data));
            }
        } else {
            const sent = []

            const authorized = await this.authorize.check(data, socket.user_id)
            if (authorized && authorized.authorized)
                data = authorized.authorized

            if (data.log !== false && data.log !== 'false' && !data.method.startsWith('read.') && data.method !== 'updateUserStatus' && data.method !== 'userStatus' && data.method !== 'signIn' && data.method !== 'signUp') {
                // let object = { url: socket.socketUrl, data }
                // delete object.socket
                // this.emit('create.object', {
                //     method: 'create.object',
                //     array: 'message_log',
                //     object,
                //     organization_id: data.organization_id
                // });
            }

            let sockets = this.get(data);

            delete data.socket

            for (let i = 0; i < sockets.length; i++) {
                const authorized = await this.authorize.check(data, sockets[i].user_id)
                if (authorized && authorized.authorized)
                    sockets[i].send(JSON.stringify(authorized.authorized));
                else
                    sockets[i].send(JSON.stringify(data));
                sent.push(socket.clientId)
                this.emit("setBandwidth", {
                    type: 'out',
                    data: authorized.authorized || data,
                    organization_id: socket.organization_id
                })
            }

            // TODO: sent is an array of clientId's so that notification can send to subscribed clients that are not currently connected
            this.emit("notification", { sent })
        }
    }

    getConfigFromUrl(pathname) {
        const path = pathname.split("/");
        if (path[2]) {
            path[2] = decodeURIComponent(path[2]);
            path[2] = JSON.parse(path[2]) || {};
        }

        const config = {
            organization_id: path[1],
            ...path[2]
        }
        return config
    }

}

module.exports = SocketServer
