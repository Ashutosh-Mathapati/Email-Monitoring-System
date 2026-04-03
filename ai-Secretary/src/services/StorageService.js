// StorageService.js
const fs = require('fs');
const path = require('path');
const TOKEN_FILE = path.join(__dirname, '..', '..', 'tokens.json');

class StorageService {
    saveToken(email, tokenData) {
        let tokens = {};
        if (fs.existsSync(TOKEN_FILE)) {
            tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
        }
        tokens[email.toLowerCase()] = tokenData;
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    }

    getToken(email) {
        if (!fs.existsSync(TOKEN_FILE)) return null;
        const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
        return tokens[email.toLowerCase()] || null;
    }
}

module.exports = new StorageService();
