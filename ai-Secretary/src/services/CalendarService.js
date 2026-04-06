const axios = require("axios");
const tokenManager = require("../TokenManager");

class CalendarService {
    // 1. THE MAIN ENTRY POINT
    async scheduleTask(aiData) {
        try {
            const token = await tokenManager.getAccessToken();
            
            // Normalize duration (default to 30 mins if missing)
            const durationMinutes = aiData.duration ?? aiData.duration_minutes ?? 30;

            // Determine requested start (Force all calculations to be based on current context)
            let requestedStart = aiData.suggested_time ? new Date(aiData.suggested_time) : new Date();
            
            // Fix: Year logic (Ensure 2026 or current year, whichever is later)
            const currentYear = new Date().getFullYear();
            if (requestedStart.getFullYear() < 2026) {
                requestedStart.setFullYear(Math.max(2026, currentYear));
            }

            console.log(`[CHECKING] Scanning calendar for: ${requestedStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);

            // 2. RUN CONFLICT DETECTION (Returns a clean Date object)
            const finalStartTime = await this.findFreeSlot(requestedStart, durationMinutes);
            
            if (finalStartTime.getTime() !== requestedStart.getTime()) {
                console.log(`[RESCHEDULED] Conflict detected. Moving to: ${finalStartTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
            }

            const endTime = new Date(finalStartTime.getTime() + durationMinutes * 60000);

            // 3. THE MICROSOFT GRAPH PAYLOAD
            // We send the time as UTC to avoid "double conversion" errors in Outlook
            const eventPayload = {
                subject: `📅 AI AGENT: ${aiData.action_item}`,
                body: {
                    contentType: "HTML",
                    content: `<b>Task Summary:</b> ${aiData.summary || 'Executive Task'}<br/><i>Automatically managed by AI Secretary.</i>`
                },
                start: {
                    dateTime: finalStartTime.toISOString(), 
                    timeZone: "UTC" 
                },
                end: {
                    dateTime: endTime.toISOString(),
                    timeZone: "UTC"
                },
                location: { displayName: "AI Generated" },
                importance: aiData.priority === "High" ? "high" : "normal"
            };

            const response = await axios.post(
                "https://graph.microsoft.com/v1.0/me/events",
                eventPayload,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                        "Prefer": 'outlook.timezone="UTC"' // Standardize API processing on UTC
                    }
                }
            );

            console.log(`[SUCCESS] Event synced to Outlook. ID: ${response.data.id.substring(0, 10)}...`);
            
            // Return clean Date objects for DbService to save
            return {
                eventId: response.data.id,
                start: finalStartTime,
                end: endTime
            };

        } catch (err) {
            console.error("Critical Scheduling Error:", err.response?.data || err.message);
            return null;
        }
    }

    // 4. THE CONFLICT DETECTION ENGINE
    async findFreeSlot(requestedStart, durationMinutes) {
        const token = await tokenManager.getAccessToken();
        
        // Define a window to check (from the requested time to the end of that day)
        const endWindow = new Date(requestedStart);
        endWindow.setHours(23, 59, 59, 999);

        try {
            const response = await axios.get(
                `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${requestedStart.toISOString()}&endDateTime=${endWindow.toISOString()}`,
                { 
                    headers: { 
                        Authorization: `Bearer ${token}`,
                        // We ask the API to return results in UTC so our math is 1:1
                        "Prefer": 'outlook.timezone="UTC"' 
                    } 
                }
            );

            const events = response.data.value;
            let potentialStart = new Date(requestedStart);

            // Loop through existing events and "push" the potentialStart forward
            for (const calEvent of events) {
                const eventStart = new Date(calEvent.start.dateTime);
                const eventEnd = new Date(calEvent.end.dateTime);
                const potentialEnd = new Date(potentialStart.getTime() + durationMinutes * 60000);

                // Check for overlap logic
                if (potentialStart < eventEnd && potentialEnd > eventStart) {
                    console.log(`[DEBUG] Found overlap with: "${calEvent.subject}". Shifting...`);
                    // Move start to the end of the conflict + 5 min buffer
                    potentialStart = new Date(eventEnd.getTime() + 5 * 60000);
                }
            }

            // 5. WORKING HOURS LOGIC (9 AM - 10 PM IST)
            // 10 PM IST is 16:30 UTC. 
            // Since we are using UTC Date objects, we check against the UTC hour.
            const istHour = new Date(potentialStart.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours();

            if (istHour >= 22 || istHour < 9) {
                console.log("[DAY FULL] Task pushed past 10 PM. Moving to tomorrow 9 AM IST...");
                // Calculate Tomorrow at 9:00 AM IST
                let tomorrow = new Date(potentialStart);
                tomorrow.setDate(tomorrow.getDate() + (istHour >= 22 ? 1 : 0));
                
                // Construct a string for 9 AM IST to avoid messy math
                const tomorrowStr = tomorrow.toISOString().split('T')[0];
                const nextDayStart = new Date(`${tomorrowStr}T03:30:00Z`); // 03:30 UTC = 09:00 IST
                
                return this.findFreeSlot(nextDayStart, durationMinutes); // Re-run for the new day
            }

            return potentialStart;

        } catch (err) {
            console.error("Conflict API Error:", err.message);
            return requestedStart; // Fallback to original
        }
    }
}

module.exports = new CalendarService();
