const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const natural = require('natural');

class DatabaseManager {
    constructor(dbPath = './database/ai_cache.db') {
        this.db = new sqlite3.Database(dbPath);
        this.tokenizer = new natural.WordTokenizer();
        this.stemmer = natural.PorterStemmer;
        this.initDatabase();
    }

    initDatabase() {
        return new Promise((resolve, reject) => {
            const fs = require('fs');
            const schemaPath = path.join(__dirname, 'schema.sql');
            
            if (fs.existsSync(schemaPath)) {
                const schema = fs.readFileSync(schemaPath, 'utf8');
                this.db.exec(schema, (err) => {
                    if (err) {
                        console.error('Ошибка инициализации базы данных:', err);
                        reject(err);
                    } else {
                        console.log('База данных успешно инициализирована');
                        resolve();
                    }
                });
            } else {
                reject(new Error('Файл схемы не найден'));
            }
        });
    }

    // Генерация хэша для запроса
    generateQueryHash(query) {
        const normalizedQuery = query.toLowerCase().trim();
        return crypto.createHash('md5').update(normalizedQuery).digest('hex');
    }

    // Извлечение ключевых слов из текста
    extractKeywords(text) {
        const words = this.tokenizer.tokenize(text.toLowerCase());
        const stopWords = new Set(['и', 'в', 'на', 'с', 'по', 'для', 'от', 'до', 'как', 'что', 'это', 'или', 'но', 'а', 'же', 'уже', 'еще', 'только', 'даже', 'может', 'быть', 'все', 'всего', 'при', 'через', 'над', 'под', 'без', 'из', 'к', 'о', 'об', 'про', 'за', 'перед', 'после', 'между', 'среди']);
        
        return words
            .filter(word => word.length > 2 && !stopWords.has(word))
            .map(word => this.stemmer.stem(word))
            .filter(word => word.length > 2);
    }

    // Сохранение разговора в кэш
    async saveConversation(userQuery, aiResponse, userId = null, sessionId = null, metadata = {}) {
        const queryHash = this.generateQueryHash(userQuery);
        const conversationId = require('uuid').v4();
        const keywords = this.extractKeywords(userQuery);

        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                // Сохраняем основной разговор
                const insertConversation = `
                    INSERT OR REPLACE INTO conversations 
                    (id, user_query, ai_response, query_hash, user_id, session_id, metadata, usage_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                `;
                
                this.db.run(insertConversation, [
                    conversationId,
                    userQuery,
                    aiResponse,
                    queryHash,
                    userId,
                    sessionId,
                    JSON.stringify(metadata)
                ], function(err) {
                    if (err) {
                        this.db.run('ROLLBACK');
                        reject(err);
                        return;
                    }

                    // Сохраняем ключевые слова
                    const insertKeyword = `
                        INSERT INTO query_keywords (conversation_id, keyword, weight)
                        VALUES (?, ?, ?)
                    `;

                    let keywordCount = 0;
                    const totalKeywords = keywords.length;

                    if (totalKeywords === 0) {
                        this.db.run('COMMIT', (err) => {
                            if (err) reject(err);
                            else resolve(conversationId);
                        });
                        return;
                    }

                    keywords.forEach((keyword, index) => {
                        const weight = 1.0 - (index * 0.1); // Первые слова важнее
                        this.db.run(insertKeyword, [conversationId, keyword, weight], (err) => {
                            keywordCount++;
                            if (err) {
                                console.error('Ошибка сохранения ключевого слова:', err);
                            }
                            
                            if (keywordCount === totalKeywords) {
                                this.db.run('COMMIT', (err) => {
                                    if (err) {
                                        this.db.run('ROLLBACK');
                                        reject(err);
                                    } else {
                                        resolve(conversationId);
                                    }
                                });
                            }
                        });
                    });
                });
            });
        });
    }

    // Поиск похожих разговоров
    async findSimilarConversations(query, limit = 5, minSimilarity = 0.3) {
        const queryKeywords = this.extractKeywords(query);
        const queryHash = this.generateQueryHash(query);

        return new Promise((resolve, reject) => {
            // Сначала проверяем точное совпадение по хэшу
            this.db.get(
                'SELECT * FROM conversations WHERE query_hash = ?',
                [queryHash],
                (err, exactMatch) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (exactMatch) {
                        // Увеличиваем счетчик использования
                        this.updateUsageCount(exactMatch.id);
                        resolve([{
                            ...exactMatch,
                            similarity: 1.0,
                            matchType: 'exact'
                        }]);
                        return;
                    }

                    // Поиск по ключевым словам
                    if (queryKeywords.length === 0) {
                        resolve([]);
                        return;
                    }

                    const keywordPlaceholders = queryKeywords.map(() => '?').join(',');
                    const query = `
                        SELECT DISTINCT c.*, 
                               SUM(k.weight) as total_weight,
                               COUNT(k.keyword) as keyword_matches,
                               (SUM(k.weight) / ${queryKeywords.length}) as similarity
                        FROM conversations c
                        JOIN query_keywords k ON c.id = k.conversation_id
                        WHERE k.keyword IN (${keywordPlaceholders})
                        GROUP BY c.id
                        HAVING similarity >= ?
                        ORDER BY similarity DESC, c.usage_count DESC
                        LIMIT ?
                    `;

                    this.db.all(query, [...queryKeywords, minSimilarity, limit], (err, rows) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        // Обновляем счетчики использования для найденных результатов
                        rows.forEach(row => {
                            this.updateUsageCount(row.id);
                        });

                        const results = rows.map(row => ({
                            ...row,
                            similarity: row.similarity,
                            matchType: 'similar'
                        }));

                        resolve(results);
                    });
                }
            );
        });
    }

    // Обновление счетчика использования
    updateUsageCount(conversationId) {
        this.db.run(
            'UPDATE conversations SET usage_count = usage_count + 1 WHERE id = ?',
            [conversationId],
            (err) => {
                if (err) {
                    console.error('Ошибка обновления счетчика использования:', err);
                }
            }
        );

        // Записываем статистику доступа
        this.db.run(
            'INSERT INTO usage_stats (conversation_id) VALUES (?)',
            [conversationId],
            (err) => {
                if (err) {
                    console.error('Ошибка записи статистики:', err);
                }
            }
        );
    }

    // Получение статистики кэша
    async getCacheStats() {
        return new Promise((resolve, reject) => {
            const queries = [
                'SELECT COUNT(*) as total_conversations FROM conversations',
                'SELECT COUNT(*) as total_keywords FROM query_keywords',
                'SELECT COUNT(*) as total_accesses FROM usage_stats',
                'SELECT AVG(usage_count) as avg_usage FROM conversations',
                'SELECT MAX(usage_count) as max_usage FROM conversations'
            ];

            Promise.all(queries.map(query => 
                new Promise((resolveQuery, rejectQuery) => {
                    this.db.get(query, (err, row) => {
                        if (err) rejectQuery(err);
                        else resolveQuery(Object.values(row)[0]);
                    });
                })
            )).then(results => {
                resolve({
                    totalConversations: results[0],
                    totalKeywords: results[1],
                    totalAccesses: results[2],
                    avgUsage: Math.round(results[3] * 100) / 100,
                    maxUsage: results[4]
                });
            }).catch(reject);
        });
    }

    // Очистка старых записей
    async cleanupOldRecords(daysOld = 30) {
        return new Promise((resolve, reject) => {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysOld);

            this.db.run(
                'DELETE FROM conversations WHERE created_at < ? AND usage_count < 2',
                [cutoffDate.toISOString()],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes);
                    }
                }
            );
        });
    }

    // Закрытие соединения с базой данных
    close() {
        return new Promise((resolve) => {
            this.db.close((err) => {
                if (err) {
                    console.error('Ошибка закрытия базы данных:', err);
                } else {
                    console.log('Соединение с базой данных закрыто');
                }
                resolve();
            });
        });
    }
}

module.exports = DatabaseManager;
