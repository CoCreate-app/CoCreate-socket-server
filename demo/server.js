'use strict';
const express = require('express');
const cors = require('cors')
const urlencoded = require('body-parser').urlencoded;

const app = express();
app.use(cors())
app.use(urlencoded({ extended: false }));

const socketServer = require("@cocreate/socket-server")
const wsManager = new socketServer("ws");

const { createServer } = require('http');
const server = createServer(app);
server.on('upgrade', function upgrade(request, socket, head) {
    if (!wsManager.handleUpgrade(request, socket, head)) {
        socket.destroy();
    }
});

const components = require("./components")
components.init(app, wsManager)

server.listen(process.env.PORT || 3000);
