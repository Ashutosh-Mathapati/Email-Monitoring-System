const axios = require("axios");
const tokenManager = require("../TokenManager");
const dbService = require("./DbService");

class CalendarService {
    // 1. THE MAIN FUNCTION CALLED BY APP.JS
    async scheduleTask(aiData) {
        try {
            const token = await tokenManager.getAccessToken();
            
            // Normalize duration from AI data or database row
            const durationMinutes = aiData.duration ?? aiData.duration_minutes ?? 30;

            // Determine requested start (use AI-extracted time or default to now)
            let requestedStart;
            if (aiData.suggested_time) {
                // Parse the ISO time as IST (no conversion, keep as IST)
                try {
                    requestedStart = this.parseIST(aiData.suggested_time);
                    if (!requestedStart || isNaN(requestedStart.getTime())) {
                        throw new Error("Invalid date after parsing");
                    }
                    const istDisplay = requestedStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
                    console.log(`[AI-EXTRACTED TIME] ${aiData.suggested_time} IST (keeping as IST, no conversion)`);
                    console.log(`[DISPLAY] Calendar will show: ${istDisplay} IST`);
                } catch (parseErr) {
                    console.warn(`[PARSE ERROR] Could not parse suggested_time: ${parseErr.message}, using current time`);
                    requestedStart = new Date();
                }
            } else {
                requestedStart = new Date();
                const istDisplay = requestedStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
                console.log(`[DEFAULT TIME] No time specified, using current time: ${istDisplay} IST`);
            }
            
            // Ensure we are working with the correct year (2026)
            if (requestedStart.getFullYear() < 2026) {
                console.log(`[YEAR CORRECTION] Year was ${requestedStart.getFullYear()}, setting to 2026`);
                requestedStart.setFullYear(2026);
            }

            console.log(`[CHECKING] Looking for conflicts at ${requestedStart.toLocaleString()}...`);

            // 2. RUN PRIORITY-AWARE CONFLICT DETECTION
            const scheduleDecision = await this.findPriorityAwareSlot(requestedStart, durationMinutes, aiData);
            const finalStartTime = scheduleDecision.start;
            
            if (finalStartTime.getTime() !== requestedStart.getTime()) {
                console.log(`[RESCHEDULED] Conflict found! Moving from ${requestedStart.toLocaleString()} to: ${finalStartTime.toLocaleString()}`);
            } else {
                console.log(`[CONFIRMED] No conflicts. Scheduling at: ${finalStartTime.toLocaleString()}`);
            }

            scheduleDecision.reasoning.forEach(line => console.log(`[PRIORITY DECISION] ${line}`));

            const endTime = new Date(finalStartTime.getTime() + durationMinutes * 60000);

            // 3. THE ACTUAL API CALL - USING IST TIMEZONE
            const eventPayload = {
                subject: `📅 AI AGENT: ${aiData.action_item}`,
                body: {
                    contentType: "HTML",
                    content: `<b>Summary:</b> ${aiData.summary}<br/><i>Scheduled by AI Secretary.</i>`
                },
                start: {
                    dateTime: finalStartTime.toISOString(),
                    timeZone: "India Standard Time"
                },
                end: {
                    dateTime: endTime.toISOString(),
                    timeZone: "India Standard Time"
                },
                location: { displayName: "AI Office" }
            };

            const response = await axios.post(
                "https://graph.microsoft.com/v1.0/me/events",
                eventPayload,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                        "Prefer": 'outlook.timezone="India Standard Time"'
                    }
                }
            );

            // 4. LOG SUCCESS WITH EVENT ID
            console.log(`[SUCCESS] Event created in Outlook! ID: ${response.data.id.substring(0, 10)}...`);
            console.log(`[CALENDAR] Event scheduled: "${aiData.action_item}" on ${finalStartTime.toDateString()} at ${finalStartTime.toLocaleTimeString()}`);
            
            return {
                eventId: response.data.id,
                start: finalStartTime,
                end: endTime,
                decisionLog: scheduleDecision.reasoning
            };

        } catch (err) {
            console.error("Critical Scheduling Error:", err.response?.data || err.message);
            return null;
        }
    }

    // PARSE IST TIME - Keep as IST, no conversion
    parseIST(istTimeString) {
        // Handle edge cases: null, undefined, or already a Date object
        if (!istTimeString) {
            console.warn("[TIMEZONE] Warning: istTimeString is null/undefined, using current time");
            return new Date();
        }

        // If already a Date object, use it
        if (istTimeString instanceof Date) {
            console.log(`[TIMEZONE] Input is already a Date: ${istTimeString.toISOString()}`);
            return istTimeString;
        }

        // Convert to string if it's not
        const timeStr = String(istTimeString).trim();
        
        try {
            // Parse the date components from ISO string like "2026-04-30T10:00:00"
            const [datePart, timePart] = timeStr.split('T');
            const [year, month, day] = datePart.split('-').map(Number);
            const [hour, minute, second] = (timePart || '10:00:00').split(':').map(Number);
            
            // Validate parsed values
            if (!year || !month || !day) {
                console.warn(`[TIMEZONE] Invalid date format: ${timeStr}`);
                return new Date();
            }
            
            // Create date with IST values (no conversion, keep as-is)
            const istDate = new Date(year, month - 1, day, hour || 10, minute || 0, second || 0);
            
            console.log(`[TIMEZONE] Parsed IST: ${timeStr} → Using as: ${istDate.toISOString()}`);
            return istDate;
        } catch (e) {
            console.error(`[TIMEZONE] Error parsing ${timeStr}:`, e.message);
            return new Date();
        }
    }

    // TIMEZONE DETECTION: Detect timezone from sender email domain or header
    detectSenderTimezone(fromEmail, emailHeaders = {}) {
        // Check email headers for timezone info
        if (emailHeaders.x_mailer) {
            if (emailHeaders.x_mailer.includes('India') || emailHeaders.x_mailer.includes('IST')) {
                console.log(`[TIMEZONE DETECT] Sender using IST (from email header)`);
                return 'Asia/Kolkata';
            }
        }

        // Check email domain heuristics
        if (fromEmail) {
            const domain = fromEmail.split('@')[1]?.toLowerCase() || '';
            if (domain.includes('.in') || domain.includes('india')) {
                console.log(`[TIMEZONE DETECT] Sender from India domain: ${domain} → IST`);
                return 'Asia/Kolkata';
            }
            if (domain.includes('.uk') || domain.includes('london')) {
                console.log(`[TIMEZONE DETECT] Sender from UK domain: ${domain} → GMT`);
                return 'Europe/London';
            }
            if (domain.includes('.us') || domain.includes('usa')) {
                console.log(`[TIMEZONE DETECT] Sender from US domain: ${domain} → EST`);
                return 'America/New_York';
            }
        }

        // Default to IST
        console.log(`[TIMEZONE DETECT] No sender timezone info found, defaulting to IST`);
        return 'Asia/Kolkata';
    }

    // LOCALIZE TIME FOR PARTICIPANT: Convert IST to participant's timezone
    localizeTimeForParticipant(istTime, participantTimezone) {
        if (!participantTimezone) participantTimezone = 'Asia/Kolkata';
        
        try {
            const participantTime = istTime.toLocaleString('en-US', { timeZone: participantTimezone });
            return {
                timezone: participantTimezone,
                localTime: participantTime,
                iso: istTime.toISOString()
            };
        } catch (e) {
            console.error(`[TIMEZONE] Error localizing for ${participantTimezone}:`, e.message);
            return {
                timezone: participantTimezone,
                localTime: istTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                iso: istTime.toISOString()
            };
        }
    }

    // BUILD PARTICIPANT TIMEZONE INFO FOR EMAIL BODY
    buildParticipantTimezoneInfo(senderEmail, receiverEmail, eventTime) {
        const senderTz = this.detectSenderTimezone(senderEmail);
        const receiverTz = this.detectSenderTimezone(receiverEmail);
        
        const senderTime = this.localizeTimeForParticipant(eventTime, senderTz);
        const receiverTime = this.localizeTimeForParticipant(eventTime, receiverTz);
        
        return {
            sender: { email: senderEmail, ...senderTime },
            receiver: { email: receiverEmail, ...receiverTime },
            original_ist: eventTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        };
    }

    getPriorityScore(priority) {
        const normalized = (priority || "Medium").toString().trim().toLowerCase();
        if (normalized === "high") return 3;
        if (normalized === "low") return 1;
        return 2;
    }

    getEventPriority(calEvent, task) {
        if (task?.priority) return task.priority;

        const importance = (calEvent.importance || "").toLowerCase();
        if (importance === "high") return "High";
        if (importance === "low") return "Low";
        return "Medium";
    }

    getEventId(calEvent) {
        return calEvent.id || calEvent.iCalUId || calEvent.subject || "";
    }

    getEventStart(calEvent) {
        return new Date(calEvent.start.dateTime);
    }

    getEventEnd(calEvent) {
        return new Date(calEvent.end.dateTime);
    }

    overlaps(startA, endA, startB, endB) {
        return startA < endB && endA > startB;
    }

    async getCalendarEvents(startWindow, endWindow) {
        const token = await tokenManager.getAccessToken();
        const response = await axios.get(
            `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${startWindow.toISOString()}&endDateTime=${endWindow.toISOString()}`,
            { 
                headers: { 
                    Authorization: `Bearer ${token}`,
                    "Prefer": 'outlook.timezone="India Standard Time"' 
                } 
            }
        );

        return response.data.value || [];
    }

    async getEventsForDay(start) {
        const startWindow = new Date(start);
        startWindow.setHours(0, 0, 0, 0);

        const endWindow = new Date(start);
        endWindow.setHours(23, 59, 59);

        return this.getCalendarEvents(startWindow, endWindow);
    }

    async enrichConflict(calEvent) {
        const task = await dbService.getTaskByOutlookEventId(calEvent.id);
        const priority = this.getEventPriority(calEvent, task);

        return {
            calEvent,
            task,
            priority,
            priorityScore: this.getPriorityScore(priority),
            start: this.getEventStart(calEvent),
            end: this.getEventEnd(calEvent),
            subject: calEvent.subject || task?.action_item || "Untitled meeting"
        };
    }

    async getConflicts(candidateStart, durationMinutes, ignoredEventIds = new Set(), reservedSlots = []) {
        const candidateEnd = new Date(candidateStart.getTime() + durationMinutes * 60000);
        const events = await this.getEventsForDay(candidateStart);
        const conflicts = [];

        for (const calEvent of events) {
            const eventId = this.getEventId(calEvent);
            if (ignoredEventIds.has(eventId)) continue;

            const eventStart = this.getEventStart(calEvent);
            const eventEnd = this.getEventEnd(calEvent);
            if (this.overlaps(candidateStart, candidateEnd, eventStart, eventEnd)) {
                conflicts.push(await this.enrichConflict(calEvent));
            }
        }

        for (const slot of reservedSlots) {
            if (this.overlaps(candidateStart, candidateEnd, slot.start, slot.end)) {
                conflicts.push({
                    calEvent: null,
                    task: null,
                    priority: "Reserved",
                    priorityScore: 99,
                    start: slot.start,
                    end: slot.end,
                    subject: slot.subject || "Reserved reschedule slot"
                });
            }
        }

        return conflicts.sort((a, b) => a.start - b.start);
    }

    async findNextAvailableSlot(requestedStart, durationMinutes, ignoredEventIds = new Set(), reservedSlots = []) {
        let potentialStart = new Date(requestedStart);
        const reasoning = [];

        while (true) {
            if (potentialStart.getHours() >= 22) {
                reasoning.push(`Working day exhausted at ${potentialStart.toLocaleString()}; checking next day at 9:00 AM.`);
                potentialStart.setDate(potentialStart.getDate() + 1);
                potentialStart.setHours(9, 0, 0, 0);
            }

            const conflicts = await this.getConflicts(potentialStart, durationMinutes, ignoredEventIds, reservedSlots);
            if (conflicts.length === 0) {
                return { start: potentialStart, reasoning };
            }

            const latestConflictEnd = conflicts.reduce((latest, conflict) => {
                return conflict.end > latest ? conflict.end : latest;
            }, conflicts[0].end);

            reasoning.push(`Next best slot check skipped ${conflicts.length} conflict(s); moving after ${latestConflictEnd.toLocaleString()}.`);
            potentialStart = new Date(latestConflictEnd.getTime() + 5 * 60000);
        }
    }

    async rescheduleCalendarEvent(conflict, newStart, durationMinutes) {
        if (!conflict.calEvent?.id) {
            throw new Error(`Cannot reschedule "${conflict.subject}" because it has no Outlook event id.`);
        }

        const token = await tokenManager.getAccessToken();
        const newEnd = new Date(newStart.getTime() + durationMinutes * 60000);
        const payload = {
            start: {
                dateTime: newStart.toISOString(),
                timeZone: "India Standard Time"
            },
            end: {
                dateTime: newEnd.toISOString(),
                timeZone: "India Standard Time"
            }
        };

        await axios.patch(
            `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(conflict.calEvent.id)}`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "Prefer": 'outlook.timezone="India Standard Time"'
                }
            }
        );

        if (conflict.task?.id) {
            await dbService.updateTaskScheduleTimes(conflict.task.id, newStart, newEnd);
        }

        return { start: newStart, end: newEnd };
    }

    async rescheduleLowerPriorityConflicts(conflicts, incomingEnd, durationMinutes, incomingEventId, reasoning) {
        const ignoredEventIds = new Set([incomingEventId].filter(Boolean));
        const reservedSlots = [{ start: new Date(incomingEnd.getTime() - durationMinutes * 60000), end: incomingEnd, subject: "Incoming higher-priority meeting" }];
        let searchStart = new Date(incomingEnd.getTime() + 5 * 60000);

        for (const conflict of conflicts.sort((a, b) => a.start - b.start)) {
            const conflictDuration = Math.max(15, Math.round((conflict.end - conflict.start) / 60000));
            ignoredEventIds.add(this.getEventId(conflict.calEvent));

            const nextSlot = await this.findNextAvailableSlot(searchStart, conflictDuration, ignoredEventIds, reservedSlots);
            nextSlot.reasoning.forEach(line => reasoning.push(`For "${conflict.subject}": ${line}`));

            const moved = await this.rescheduleCalendarEvent(conflict, nextSlot.start, conflictDuration);
            reservedSlots.push({ start: moved.start, end: moved.end, subject: conflict.subject });
            searchStart = new Date(moved.end.getTime() + 5 * 60000);
            reasoning.push(`Rescheduled lower-priority "${conflict.subject}" (${conflict.priority}) to ${moved.start.toLocaleString()}.`);
        }
    }

    async findPriorityAwareSlot(requestedStart, durationMinutes, aiData) {
        const incomingPriority = aiData.priority || "Medium";
        const incomingPriorityScore = this.getPriorityScore(incomingPriority);
        const reasoning = [`Incoming meeting "${aiData.action_item}" is ${incomingPriority} priority.`];
        let potentialStart = new Date(requestedStart);

        while (true) {
            const taskEnd = new Date(potentialStart.getTime() + durationMinutes * 60000);
            const conflicts = await this.getConflicts(potentialStart, durationMinutes);

            if (conflicts.length === 0) {
                reasoning.push(`No conflicts found at ${potentialStart.toLocaleString()}; keeping requested slot.`);
                return { start: potentialStart, reasoning };
            }

            conflicts.forEach(conflict => {
                reasoning.push(`Conflict: "${conflict.subject}" from ${conflict.start.toLocaleString()} to ${conflict.end.toLocaleString()} is ${conflict.priority} priority.`);
            });

            const blockingConflicts = conflicts.filter(conflict => conflict.priorityScore >= incomingPriorityScore);

            if (blockingConflicts.length === 0) {
                reasoning.push(`Incoming ${incomingPriority} priority outranks all ${conflicts.length} conflict(s); keeping requested slot and moving lower-priority meeting(s).`);
                await this.rescheduleLowerPriorityConflicts(conflicts, taskEnd, durationMinutes, null, reasoning);
                return { start: potentialStart, reasoning };
            }

            const latestBlockingEnd = blockingConflicts.reduce((latest, conflict) => {
                return conflict.end > latest ? conflict.end : latest;
            }, blockingConflicts[0].end);

            reasoning.push(`${blockingConflicts.length} same-or-higher priority conflict(s) block the requested slot; searching after ${latestBlockingEnd.toLocaleString()}.`);
            potentialStart = new Date(latestBlockingEnd.getTime() + 5 * 60000);

            if (potentialStart.getHours() >= 22) {
                reasoning.push(`No suitable slot remains today; moving search to tomorrow at 9:00 AM.`);
                potentialStart.setDate(potentialStart.getDate() + 1);
                potentialStart.setHours(9, 0, 0, 0);
            }
        }
    }

    // 5. THE CONFLICT DETECTION ENGINE
    async findFreeSlot(requestedStart, durationMinutes) {
        const token = await tokenManager.getAccessToken();
        const endWindow = new Date(requestedStart);
        endWindow.setHours(23, 59, 59);

        const response = await axios.get(
            `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${requestedStart.toISOString()}&endDateTime=${endWindow.toISOString()}`,
            { 
                headers: { 
                    Authorization: `Bearer ${token}`,
                    "Prefer": 'outlook.timezone="India Standard Time"' 
                } 
            }
        );

        const events = response.data.value;
        let potentialStart = new Date(requestedStart);

        for (const calEvent of events) {
            const eventStart = new Date(calEvent.start.dateTime);
            const eventEnd = new Date(calEvent.end.dateTime);
            const taskEnd = new Date(potentialStart.getTime() + durationMinutes * 60000);

            // If overlap exists
            if (potentialStart < eventEnd && taskEnd > eventStart) {
                console.log(`[DEBUG] Conflict with "${calEvent.subject}".`);
                potentialStart = new Date(eventEnd.getTime() + 5 * 60000); // 5 min buffer
            }
        }

        // Working Hours logic (9 AM - 10 PM)
        if (potentialStart.getHours() >= 22) {
             console.log("[DAY FULL] Pushing to tomorrow...");
            potentialStart.setDate(potentialStart.getDate() + 1);
            potentialStart.setHours(9, 0, 0, 0);
            return this.findFreeSlot(potentialStart, durationMinutes);
        }

        return potentialStart;
    }
}

module.exports = new CalendarService();
