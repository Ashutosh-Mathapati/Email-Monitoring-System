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
            // 1. Try to get the saved bookmark from Supabase
            const savedLink = await pool.query("SELECT value FROM settings WHERE key = 'last_delta_link'");
            let deltaLink = savedLink.rows[0]?.value || null;

            // 2. Build the URL (me/messages/delta is often more stable than the inbox-specific one)
            let url = deltaLink || "https://graph.microsoft.com/v1.0/me/messages/delta?$select=subject,from,bodyPreview,receivedDateTime";

            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            });

            // 3. Save the NEW bookmark back to Supabase
            const newDelta = response.data["@odata.deltaLink"] || response.data["@odata.nextLink"];
            if (newDelta) {
                await pool.query(
                    "INSERT INTO settings (key, value) VALUES ('last_delta_link', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                    [newDelta]
                );
            }

            return response.data.value.filter(msg => msg["@removed"] === undefined);

        } catch (err) {
            // --- THE 404 FIX ---
            if (err.response && err.response.status === 404) {
                console.warn("[SYNC] Delta token expired or invalid. Resetting sync state...");
                await pool.query("DELETE FROM settings WHERE key = 'last_delta_link'");
                return []; // It will start fresh on the next interval
            }
            
            console.error("Email Fetch Error:", err.message);
            return [];
        }
    }
}

module.exports = new EmailService();
