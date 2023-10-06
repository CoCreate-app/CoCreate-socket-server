const socket = require('@cocreate/socket-client')
const crud = require('@cocreate/crud-client')
const EventEmitter = require('events');
const eventEmitter = new EventEmitter();


const organizations = {}
const urls = new Map()
const servers = {}

async function addServer(data) {
    if (!servers[data.url])
        servers[data.url] = { [data.serverId]: { [data.organization_id]: true } }
    else
        servers[data.url][data.serverId][data.organization_id] = true

    // TODO: needs to get orgaizations activeRegions
    let activeRegions = await crud.send({
        method: 'read.object',
        array: 'organizations',
        object: { _id: data.organization_id },
        organization_id: data.organization_id
    })

    console.log('mesh activeRegions: ', activeRegions)
    // socket.send({
    //     method: 'region.added',
    //     host: data.url,
    //     activeRegions: '',
    //     serverId: data.serverId,
    //     broadcast: false,
    //     broadcastSender: false,
    //     organization_id: data.organization_id
    // })
}

function deleteServer(data) {
    delete servers[data.url][data.serverId][data.organization_id]
    if (!Object.keys(servers[data.url][data.serverId]).length)
        delete servers[data.url][data.serverId]
    if (!Object.keys(servers[data.url]).length) {
        console.log('mesh deleteServer: ', data.url)

        // socket.send({
        //     method: 'region.removed', // delete.region
        //     host: data.url,
        //     serverId: data.serverId,
        //     organization_id: data.organization_id
        // })
        socket.delete(data.url)
    }

}

socket.listen('region.added', function (data) {
    addServer(data)
});

socket.listen('region.removed', function (data) {
    delete servers[data.url][data.serverId]
    if (!Object.keys(servers[data.url]).length)
        socket.delete(data.url)
});

eventEmitter.on('mesh.create', addServer);
eventEmitter.on('mesh.delete', deleteServer);

// eventEmitter.emit('customEvent', 'Hello, Node.js!');


// let response = await crud.send(request)
