const express = require('express');
const { createServer } = require('http');

const SocketServer = require("../src/index")

const ws_socket = new SocketServer("ws");
const port = process.env.PORT || 3000;

const app = express();

const server = createServer(app);

server.on('upgrade', function upgrade(request, socket, head) {
    if (!ws_socket.handleUpgrade(request, socket, head)) {
        socket.destroy();
    }
});

server.listen(port);
