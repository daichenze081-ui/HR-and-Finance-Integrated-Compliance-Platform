'use strict';
const {createApp}=require('../server/http.cjs');
const port=Number(process.env.PORT||4173);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT must be 1024–65535');
const {server,store}=createApp();server.on('error',e=>{console.error(e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`PeopleLedger workspace: http://127.0.0.1:${port}`));
function close(){server.close(()=>{store.close();process.exit(0);});}process.on('SIGINT',close);process.on('SIGTERM',close);
