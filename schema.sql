-- Схема базы данных для кэширования ИИ разговоров

-- Таблица для хранения разговоров
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_query TEXT NOT NULL,
    ai_response TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    query_hash TEXT NOT NULL UNIQUE,
    similarity_score REAL DEFAULT 0.0,
    usage_count INTEGER DEFAULT 1,
    user_id TEXT,
    session_id TEXT,
    metadata TEXT -- JSON для дополнительных данных
);

-- Таблица для хранения ключевых слов и индексов
CREATE TABLE IF NOT EXISTS query_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Таблица для статистики использования
CREATE TABLE IF NOT EXISTS usage_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id TEXT,
    session_id TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Индексы для оптимизации поиска
CREATE INDEX IF NOT EXISTS idx_conversations_query_hash ON conversations(query_hash);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_usage_count ON conversations(usage_count);
CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON query_keywords(keyword);
CREATE INDEX IF NOT EXISTS idx_keywords_conversation_id ON query_keywords(conversation_id);
CREATE INDEX IF NOT EXISTS idx_usage_stats_conversation_id ON usage_stats(conversation_id);
CREATE INDEX IF NOT EXISTS idx_usage_stats_accessed_at ON usage_stats(accessed_at);

-- Триггер для обновления updated_at
CREATE TRIGGER IF NOT EXISTS update_conversations_timestamp 
    AFTER UPDATE ON conversations
    BEGIN
        UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
