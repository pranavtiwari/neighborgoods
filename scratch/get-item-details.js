import https from 'https';

const url = 'https://firestore.googleapis.com/v1/projects/shareinstead/databases/(default)/documents/items/ee36K4ntlsBGyu4S2r0I';

https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            const fields = parsed.fields || {};
            const info = [];
            for (const key in fields) {
                info.push(`${key}: ${JSON.stringify(fields[key])}`);
            }
            console.log(info.join(' | '));
        } catch (err) {
            console.error('Failed to parse:', err);
        }
    });
}).on('error', (err) => {
    console.error('Request error:', err);
});
