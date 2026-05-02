import { createClient } from '@deepgram/sdk';

const key = process.env.DEEPGRAM_API_KEY;
if (!key) throw new Error('missing key');
const client = createClient(key);
const model = process.argv[2] || 'nova-3';
const options = {
  model,
  encoding: 'linear16',
  sample_rate: 16000,
};
console.log('model', model);
const connection = client.listen.live(options, model.startsWith('flux') ? '/v2/listen' : ':version/listen');
connection.on('open', () => {
  console.log('connected');
  setTimeout(() => connection.requestClose(), 800);
});
connection.on('close', () => { console.log('closed'); process.exit(0); });
connection.on('error', (error) => { console.error('error', error?.message || error?.error?.message || error); process.exit(1); });
setTimeout(() => { console.log('timeout'); process.exit(1); }, 10000);
