# Timezone Intelligence System 🌍

## Overview

The AI Secretary now includes advanced **Timezone Intelligence** that detects sender and receiver timezones, and automatically displays localized times for all participants. All times are maintained in **IST (India Standard Time)** without conversion.

---

## Key Features

### 1. **IST-Only Scheduling** ✅
- All event times are stored and scheduled in **India Standard Time (IST)**
- **NO UTC conversion** - what you see in IST is what gets scheduled
- Calendar displays times directly in IST

### 2. **Sender Timezone Detection** 🔍
Automatically detects sender timezone based on:
- **Email domain heuristics**:
  - `.in` domains → IST (Asia/Kolkata)
  - `.uk` domains → GMT (Europe/London)
  - `.us` domains → EST (America/New_York)
  - Custom domain patterns for other regions
- **Email headers** (X-Mailer, X-Originating-IP if available)

### 3. **Participant Localization** 👥
- Converts IST times to each participant's local timezone
- Displays localized times in email bodies
- Helps prevent scheduling confusion across timezones

### 4. **Time Display** 📅
- **Master Time**: All times stored in IST (e.g., `2026-04-25T15:00:00` IST)
- **Sender View**: Time shown in sender's timezone
- **Receiver View**: Time shown in receiver's timezone
- **Calendar View**: Shows IST with localized conversion info

---

## Architecture

### Files Modified

#### 1. **CalendarService.js**
New methods:
- `parseIST(istTimeString)` - Parse IST times (no conversion)
- `detectSenderTimezone(fromEmail, emailHeaders)` - Detect sender timezone
- `localizeTimeForParticipant(istTime, participantTimezone)` - Convert to local time
- `buildParticipantTimezoneInfo(senderEmail, receiverEmail, eventTime)` - Generate timezone info

#### 2. **AIService.js**
- Updated to receive `fromEmail` parameter
- Adds `sender_email` field to extracted tasks
- Maintains all times in IST (no conversion in AI extraction)

#### 3. **app.js**
- Passes `email.from.emailAddress.address` to `analyzeEmail()`
- Enables timezone detection at task extraction time

---

## Usage Examples

### Example 1: Email from London Sender

```
From: john@company.uk
Subject: Schedule meeting for April 25 at 3pm

[TIMEZONE DETECT] Sender from UK domain: company.uk → GMT
[AI-EXTRACTED TIME] 2026-04-25T15:00:00 (keeping as IST, no conversion)

Participant Times:
- Sender (London): 10:30 AM GMT
- Receiver (India): 3:00 PM IST
```

### Example 2: Email from India with Multiple Timezones

```
From: priya@techcorp.in
To: client@nyoffice.us

[TIMEZONE DETECT] Sender from India: techcorp.in → IST
[TIMEZONE DETECT] Receiver from US: nyoffice.us → EST

Master Schedule: April 30, 10:00 AM IST
- Sender (Priya): 10:00 AM IST
- Receiver (NYC): 12:30 AM EDT (previous day)
```

---

## API Reference

### CalendarService Methods

#### `parseIST(istTimeString: string): Date`
Parses ISO 8601 time string as IST without conversion.

```javascript
const istTime = calendarService.parseIST("2026-04-25T15:00:00");
// Returns: Date object representing 3 PM IST
```

#### `detectSenderTimezone(fromEmail: string, emailHeaders?: object): string`
Detects sender's timezone based on email domain or headers.

```javascript
const tz = calendarService.detectSenderTimezone("john@company.uk");
// Returns: "Europe/London"

const tz2 = calendarService.detectSenderTimezone("priya@techcorp.in");
// Returns: "Asia/Kolkata"
```

#### `localizeTimeForParticipant(istTime: Date, participantTimezone: string): object`
Converts IST time to participant's local timezone.

```javascript
const istTime = new Date("2026-04-25T15:00:00");
const result = calendarService.localizeTimeForParticipant(istTime, "Europe/London");
// Returns: {
//   timezone: "Europe/London",
//   localTime: "10:30 AM",
//   iso: "2026-04-25T09:30:00Z"
// }
```

#### `buildParticipantTimezoneInfo(senderEmail: string, receiverEmail: string, eventTime: Date): object`
Generates complete timezone information for both participants.

```javascript
const info = calendarService.buildParticipantTimezoneInfo(
  "john@company.uk",
  "team@techcorp.in",
  new Date("2026-04-25T15:00:00")
);
// Returns: {
//   sender: {
//     email: "john@company.uk",
//     timezone: "Europe/London",
//     localTime: "10:30 AM",
//     iso: "2026-04-25T09:30:00Z"
//   },
//   receiver: {
//     email: "team@techcorp.in",
//     timezone: "Asia/Kolkata",
//     localTime: "3:00 PM",
//     iso: "2026-04-25T09:30:00Z"
//   },
//   original_ist: "3:00 PM IST"
// }
```

---

## Console Logging

The system provides detailed logging for debugging:

```
[TIMEZONE DETECT] Sender from India domain: techcorp.in → IST
[AI-EXTRACTED TIME] 2026-04-25T15:00:00 IST (keeping as IST, no conversion)
[DISPLAY] Calendar will show: 3:00 PM IST
[TIMEZONE] Parsed IST: 2026-04-25T15:00:00 → Using as: 2026-04-25T09:30:00Z
```

---

## Database Considerations

### Tasks Table
New field added to track sender timezone:
- `sender_email` - Sender's email address (used for timezone detection)
- `suggested_time` - Time in IST format (no UTC conversion)

### Example Row
```sql
INSERT INTO tasks (
  action_item, 
  suggested_time, 
  sender_email, 
  received_at
) VALUES (
  'Schedule client review meeting',
  '2026-04-25T15:00:00',  -- IST only, no conversion
  'john@company.uk',
  NOW()
);
```

---

## Timezone Mapping Reference

### Supported Timezones

| Domain | Timezone | Offset from IST |
|--------|----------|-----------------|
| `.in`, `india` | IST (Asia/Kolkata) | 0:00 |
| `.uk`, `london` | GMT (Europe/London) | -5:30 |
| `.us`, `usa` | EST (America/New_York) | -10:30 |

### Adding New Timezones

To add timezone detection for new regions, edit `CalendarService.detectSenderTimezone()`:

```javascript
if (domain.includes('.au') || domain.includes('sydney')) {
    console.log(`[TIMEZONE DETECT] Sender from Australia: ${domain} → AEST`);
    return 'Australia/Sydney';
}
```

---

## Working with IST Times Only

### Correct Way ✅
```javascript
// Times are always in IST, no conversion
const eventTime = new Date("2026-04-25T15:00:00"); // 3 PM IST
calendarService.scheduleTask({
  suggested_time: "2026-04-25T15:00:00",  // IST
  duration: 60
});
```

### Incorrect Way ❌
```javascript
// DON'T convert to UTC
const eventTime = new Date("2026-04-25T09:30:00Z"); // UTC (wrong!)
// This would schedule at 2:00 AM IST instead of 3 PM
```

---

## Example: Complete Email Processing with Timezones

```javascript
// Email arrives from London
const email = {
  subject: "Schedule meeting for April 25 at 3pm",
  from: { emailAddress: { address: "john@company.uk" } },
  bodyPreview: "Let's discuss the Q2 roadmap..."
};

// AI extracts task with sender timezone
const fromEmail = "john@company.uk";  // Passed to AI
const tasks = await aiService.analyzeEmail(
  email.subject, 
  email.bodyPreview, 
  fromEmail
);
// Returns:
// {
//   title: "Schedule Q2 roadmap discussion meeting",
//   suggested_time: "2026-04-25T15:00:00",  // IST
//   sender_email: "john@company.uk"  // Tracked for timezone
// }

// Calendar service schedules in IST
const schedule = await calendarService.scheduleTask(tasks[0]);
// Logs:
// [AI-EXTRACTED TIME] 2026-04-25T15:00:00 IST (keeping as IST, no conversion)
// [DISPLAY] Calendar will show: 3:00 PM IST
// [SUCCESS] Event created in Outlook at 3:00 PM IST

// Email body can show localized times for participants
const tzInfo = calendarService.buildParticipantTimezoneInfo(
  "john@company.uk",
  "team@techcorp.in",
  new Date("2026-04-25T15:00:00")
);
// Result:
// {
//   sender: { timezone: "Europe/London", localTime: "10:30 AM" },
//   receiver: { timezone: "Asia/Kolkata", localTime: "3:00 PM" }
// }
```

---

## Testing Timezone Detection

### Quick Test
```bash
# Check if sender domain detection works
node -e "
const cal = require('./src/services/CalendarService');
console.log(cal.detectSenderTimezone('john@company.uk'));
console.log(cal.detectSenderTimezone('priya@techcorp.in'));
"
```

---

## Troubleshooting

### Issue: Times showing incorrectly
**Check**: Is `suggested_time` in IST format? IST times should not be converted.

### Issue: Sender timezone not detected
**Check**: Verify email domain is recognized. Add custom domain pattern if needed.

### Issue: Calendar showing wrong timezone
**Check**: Ensure `"India Standard Time"` is used in API header, not `"UTC"`.

---

## Future Enhancements

- [ ] Auto-detect timezone from email IP geolocation
- [ ] Store user timezone preferences in profile
- [ ] Email reminders in participant's local time
- [ ] Timezone-aware conflict detection across regions
- [ ] Multi-day event handling for extreme timezone differences

---

## Related Files

- [CalendarService.js](src/services/CalendarService.js) - Timezone handling
- [AIService.js](src/services/AIService.js) - Time extraction
- [app.js](src/app.js) - Integration point
- [SCHEDULING_FIX_SUMMARY.md](SCHEDULING_FIX_SUMMARY.md) - Previous scheduling fixes

---

## Questions?

For detailed implementation help, check the console logs with `[TIMEZONE]` prefix during email processing.
