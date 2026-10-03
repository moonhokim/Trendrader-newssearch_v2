import { createServer } from '../server.js';

const server = createServer();
const requestHandler = server.listeners('request')[0];

export default function handler(request, response) {
    return requestHandler(request, response);
}
