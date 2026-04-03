require("dotenv").config();
 
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");
 
const app = express();
const PORT = process.env.PORT || 5000;
 
let accessToken = null;
let lastEmailId = null;
 
/*
--------------------------------
Login Route
--------------------------------
*/
 
app.get("/login", (req, res) => {
 
const authUrl =
`https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_mode=query&scope=openid%20profile%20offline_access%20Mail.Read&state=123`;
 
res.redirect(authUrl);
 
});
 
/*
--------------------------------
OAuth Callback
--------------------------------
*/
 
app.get("/auth/callback", async (req, res) => {
 
const code = req.query.code;
 
try {
 
const tokenResponse = await axios.post(
`https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
new URLSearchParams({
client_id: process.env.CLIENT_ID,
scope: "openid profile offline_access Mail.Read",
code: code,
redirect_uri: process.env.REDIRECT_URI,
grant_type: "authorization_code",
client_secret: process.env.CLIENT_SECRET
})
);
 
accessToken = tokenResponse.data.access_token;
 
console.log("\nLogin successful. Access token received.\n");
 
startMailWatcher();
 
res.send("Login successful. Watching inbox...");
 
} catch (err) {
 
console.error("Token error:", err.response?.data || err.message);
res.send("Authentication failed");
 
}
 
});
 
/*
--------------------------------
Check Emails
--------------------------------
*/
 
async function checkEmails() {
 
try {
 
const response = await axios.get(
"https://graph.microsoft.com/v1.0/me/messages?$top=5&$orderby=receivedDateTime DESC",
{
headers: {
Authorization: `Bearer ${accessToken}`
}
}
);
 
const emails = response.data.value;
 
if (!emails.length) return;
 
const newestEmail = emails[0];
 
if (newestEmail.id !== lastEmailId) {
 
lastEmailId = newestEmail.id;
 
console.log("\nNew Email Received\n");
 
console.log("Subject:", newestEmail.subject);
 
console.log(
"From:",
newestEmail.from?.emailAddress?.address || "Unknown"
);
 
console.log("Preview:", newestEmail.bodyPreview);
 
console.log("Received:", newestEmail.receivedDateTime);
 
}
 
} catch (err) {
 
console.error("Email fetch error:", err.response?.data || err.message);
 
}
 
}
 
/*
--------------------------------
Start Polling
--------------------------------
*/
 
function startMailWatcher() {
 
console.log("Watching inbox for new emails...\n");
 
setInterval(checkEmails, 30000);
 
}
 
/*
--------------------------------
Start Server
--------------------------------
*/
 
app.listen(PORT, () => {
 
console.log(`Server running on http://localhost:${PORT}`);
 
try {
exec(`start "" "http://localhost:${PORT}/login"`);
} catch {
console.log("Open browser manually");
}
 
});
