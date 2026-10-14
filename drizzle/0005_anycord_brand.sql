-- Only application-owned branding changes. Human profiles and messages are untouched.
UPDATE users SET name = 'Anycord' WHERE id = 'system' AND role = 'bot' AND name = 'Cellcord' AND NOT EXISTS (SELECT 1 FROM users WHERE name = 'Anycord' AND id <> 'system');
--> statement-breakpoint
UPDATE messages SET text = 'Welcome to your server. This is the beginning of #general. Say hello, share a file, or start a thread to keep the conversation going.' WHERE id = 'welcome' AND author_id = 'system' AND text = 'Welcome to your server. This is the beginning of #general. Invite someone on this machine to create an account, or open a second session to try realtime chat.';
