const AIService = require("../src/services/AIService");

// Test email content from the example
const testEmail = {
  subject: "Q4 Planning Meeting Request",
  body: `• Date: May 30, 2026, 11:18 Pm
• Priority: High
Dear Sarah,
I hope this email finds you well. We need to schedule a Q4 planning meeting with the executive
team to finalize our strategic direction for the year.
Can you please:
• Schedule a 2-hour meeting for next Tuesday at 2:00 PM in the main conference room
• Invite: David Chen, Maria Garcia, Robert Johnson, and myself
• Prepare an agenda with Q3 performance metrics
• Send out pre-meeting documents by Friday EOD
We should also follow up with the marketing team on their budget proposal. Please request their
updated numbers by April 5th.
Thanks for taking care of this promptly. Let me know if there are any conflicts.
Best regards,
John Singh
Vice President, Strategy`,
  from: "john.singh@company.com",
  receivedAt: "2026-05-30T23:18:00Z"
};

console.log("Testing email parsing functionality...");
console.log("=====================================");

// Test deterministic task extraction
console.log("\n1. Testing deterministic task extraction:");
const deterministicTasks = AIService.extractDeterministicTasks(
  testEmail.subject, 
  testEmail.body, 
  testEmail.from, 
  testEmail.receivedAt
);

console.log("Deterministic tasks found:", deterministicTasks.length);
deterministicTasks.forEach((task, index) => {
  console.log(`Task ${index + 1}: ${task.title}`);
  console.log(`  Intent: ${task.intent}`);
  console.log(`  Priority: ${task.priority}`);
  console.log(`  Suggested Time: ${task.suggested_time}`);
  console.log(`  Duration: ${task.duration} minutes`);
  console.log(`  Participants: ${task.participants.join(', ')}`);
  console.log("");
});

// Test full AI analysis
console.log("\n2. Testing full AI analysis:");
AIService.analyzeEmail(
  testEmail.subject, 
  testEmail.body, 
  testEmail.from, 
  testEmail.receivedAt
).then(result => {
  console.log("AI Analysis Result:");
  console.log(JSON.stringify(result, null, 2));
}).catch(error => {
  console.error("Error in AI analysis:", error);
});