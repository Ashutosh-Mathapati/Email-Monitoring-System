// TokenManager.js
const axios = require("axios");
const fs = require('fs');
const path = require('path');
const storage = require("./services/StorageService");

class TokenManager {
    constructor() {
        this.currentEmail = null;
        this.accessToken = null;
        this.refreshToken = null;
        this.expiresAt = null;
    }

    initFromStorage(email) {
        this.currentEmail = email;
        const data = storage.getToken(email);
        if (data) {
            this.accessToken = data.access_token;
            this.refreshToken = data.refresh_token;
            this.expiresAt = data.expiresAt;
            return true;
        }
        return false;
    }

    setTokens(data, shouldSave = true) {
        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token || this.refreshToken;
        this.expiresAt = Date.now() + (data.expires_in * 1000);

        // SAFETY CHECK: Only proceed if this.currentEmail is actually a string
        if (shouldSave && this.currentEmail && typeof this.currentEmail === 'string') {
            const emailKey = this.currentEmail.toLowerCase();
            storage.saveToken(emailKey, {
                access_token: this.accessToken,
                refresh_token: this.refreshToken,
                expiresAt: this.expiresAt
            });
        } else if (shouldSave) {
            console.warn("[WARNING] Token received but email is missing. Token not saved to file.");
        }
    }

    async getAccessToken() {
        // Refresh if token is missing OR expires in less than 5 minutes
        if (!this.accessToken || Date.now() > (this.expiresAt - 300000)) {
            console.log("Token expired or near expiry. Triggering refresh...");
            await this.refresh();
        }
        return this.accessToken;
    }

    async refresh() {
        if (!this.refreshToken) {
            console.error("No refresh token available. Manual login required.");
            return;
        }

        try {
            const response = await axios.post(
                "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                new URLSearchParams({
                    client_id: process.env.CLIENT_ID,
                    client_secret: process.env.CLIENT_SECRET,
                    grant_type: "refresh_token",
                    refresh_token: this.refreshToken,
                })
            );

            this.setTokens(response.data);
            console.log(">>> Token Refreshed Automatically <<<");
        } catch (err) {
            console.error("Refresh failed:", err.response?.data || err.message);
            // If refresh token is also dead, we have to log in again
            this.accessToken = null; 
        }
    }
}

module.exports = new TokenManager();
