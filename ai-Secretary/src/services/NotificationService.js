const axios = require("axios");
const tokenManager = require("../TokenManager");

class NotificationService {
    async sendCompletionEmail(toEmail, taskSubject) {
        try {
            const token = await tokenManager.getAccessToken();
            const mailOptions = {
                message: {
                    subject: `✅ Task Completed: ${taskSubject}`,
                    body: {
                        contentType: "HTML",
                        content: `
                            <div style="font-family: sans-serif; border-radius: 8px; border: 1px solid #ddd; padding: 25px; max-width: 500px;">
                                <h3 style="color: #1a73e8; margin-top: 0;">✅ Task Accomplished</h3>
                                <p>Your request has been processed and completed by the <b>AI Executive Agent</b>.</p>
                                <div style="background: #f8f9fa; padding: 15px; border-left: 4px solid #1a73e8;">
                                    <b>Request:</b> ${taskSubject}<br/>
                                    <b>Completion Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                                </div>
                                <p style="font-size: 13px; margin-top: 20px; color: #666;">
                                    <i>This is an automated update for your management team.</i>
                                </p>
                            </div>
                        `
                    },
                    toRecipients: [{ emailAddress: { address: toEmail } }]
                }
            };

            await axios.post("https://graph.microsoft.com/v1.0/me/sendMail", mailOptions, {
                headers: { Authorization: `Bearer ${token}` }
            });

            console.log(`[NOTIFICATION] Success: Email sent to ${toEmail}`);
            return true; // <--- ADD THIS: Tells the caller it worked
        } catch (err) {
            console.error("Notification Error:", err.response?.data || err.message);
            return false; // <--- ADD THIS: Tells the caller it failed
        }
    }
}
module.exports = new NotificationService();
