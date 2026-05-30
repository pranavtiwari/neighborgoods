import fs from 'fs';
import path from 'path';

try {
    fs.copyFileSync('site/public/config.js', 'dist/config.js');
    fs.copyFileSync('site/public/firebase-client.js', 'dist/firebase-client.js');
    console.log('Assets copied successfully to dist/!');
} catch (e) {
    console.error('Error copying assets:', e);
    process.exit(1);
}
