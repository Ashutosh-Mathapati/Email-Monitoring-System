// This uses Delta Queries. Instead of asking for "Top 5", it asks for "Everything new since last time."

// EmailService.js
const axios = require("axios");
const tokenManager = require("../TokenManager");
const pool = require("../db");

class EmailService {
    constructor() {
        this.deltaLink = null;
        this.executiveEmail = null;
        this.trackingStartDate = null;
    }

    resetTracking(executiveEmail = null) {
        this.deltaLink = null;
        this.executiveEmail = executiveEmail;
        this.trackingStartDate = null;
    }

    async getTrackingStartDate(executiveEmail) {
        if (!executiveEmail) {
            return null;
        }

        const userRes = await pool.query(
            "SELECT tracking_start_date FROM users WHERE email = $1",
            [executiveEmail]
        );

        return userRes.rows[0]?.tracking_start_date || null;
    }

    buildDeltaUrl(startDate) {
        const baseUrl = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta";
        const select = "$select=id,subject,from,bodyPreview,receivedDateTime";

        // Do not use $filter in the delta request; Outlook.com may reject it.
        return `${baseUrl}?${select}`;
    }

    async fetchNewEmails() {
        try {
            const token = await tokenManager.getAccessToken();

            // REMOVED $select from delta URL. This is the most stable version for personal accounts.
            let url = this.deltaLink || "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta";

            const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
            this.deltaLink = response.data["@odata.deltaLink"] || response.data["@odata.nextLink"];

            return response.data.value.filter(msg => msg["@removed"] === undefined);

        } catch (err) {
            if (err.response?.status === 400 || err.response?.status === 404) {
                await pool.query("DELETE FROM settings WHERE key = 'last_delta_link'");
            }
            return [];
        }
    }
}

module.exports = new EmailService();
