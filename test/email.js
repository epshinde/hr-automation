const sendEmail = require("./sendEmail");

sendEmail(
  "shreyakakithapalli0225@gmail.com",
  "Test Email",
  "Hello! This is a test email."
)
.then(() => console.log("Done"))
.catch(console.error);