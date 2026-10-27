-- Pip acts on its own (the owner, 2026-10-27): what stays in your own world it does without asking,
-- and only what reaches other people, or changes code, waits for your yes. If background work was
-- set to read-only, it goes back to the default, so this install is on like a new one. The switch
-- is in Settings, under Pip. Pausing Pip is a separate switch, and stays as you left it.
DELETE FROM setting WHERE key = 'jarvis.backgroundReadOnly';
