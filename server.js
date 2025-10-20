const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const DatabaseManager = require('./database/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация базы данных
const dbManager = new DatabaseManager();

// Middleware для обработки ошибок базы данных
const handleDbError = (res, error, message = 'Ошибка базы данных') => {
    console.error(message, error);
    res.status(500).json({ 
        error: message, 
        details: error.message 
    });
};

// API Routes

// Получение кэшированного ответа
app.post('/api/cache/query', async (req, res) => {
    try {
        const { query, userId, sessionId, minSimilarity = 0.3 } = req.body;
        
        if (!query || typeof query !== 'string') {
            return res.status(400).json({ 
                error: 'Параметр query обязателен и должен быть строкой' 
            });
        }

        const similarConversations = await dbManager.findSimilarConversations(
            query, 
            5, 
            minSimilarity
        );

        if (similarConversations.length > 0) {
            const bestMatch = similarConversations[0];
            
            res.json({
                found: true,
                cacheHit: true,
                similarity: bestMatch.similarity,
                matchType: bestMatch.matchType,
                response: bestMatch.ai_response,
                conversationId: bestMatch.id,
                usageCount: bestMatch.usage_count,
                createdAt: bestMatch.created_at
            });
        } else {
            res.json({
                found: false,
                cacheHit: false,
                message: 'Похожих запросов в кэше не найдено'
            });
        }
    } catch (error) {
        handleDbError(res, error, 'Ошибка поиска в кэше');
    }
});

// Сохранение нового разговора в кэш
app.post('/api/cache/save', async (req, res) => {
    try {
        const { query, response, userId, sessionId, metadata = {} } = req.body;
        
        if (!query || !response) {
            return res.status(400).json({ 
                error: 'Параметры query и response обязательны' 
            });
        }

        const conversationId = await dbManager.saveConversation(
            query, 
            response, 
            userId, 
            sessionId, 
            metadata
        );

        res.json({
            success: true,
            conversationId,
            message: 'Разговор сохранен в кэш'
        });
    } catch (error) {
        handleDbError(res, error, 'Ошибка сохранения в кэш');
    }
});

// Получение статистики кэша
app.get('/api/cache/stats', async (req, res) => {
    try {
        const stats = await dbManager.getCacheStats();
        res.json({
            success: true,
            stats
        });
    } catch (error) {
        handleDbError(res, error, 'Ошибка получения статистики');
    }
});

// Получение истории разговоров
app.get('/api/cache/history', async (req, res) => {
    try {
        const { limit = 50, offset = 0, userId, sessionId } = req.query;
        
        let query = `
            SELECT id, user_query, ai_response, created_at, usage_count, query_hash
            FROM conversations
        `;
        const params = [];
        
        const conditions = [];
        if (userId) {
            conditions.push('user_id = ?');
            params.push(userId);
        }
        if (sessionId) {
            conditions.push('session_id = ?');
            params.push(sessionId);
        }
        
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        dbManager.db.all(query, params, (err, rows) => {
            if (err) {
                handleDbError(res, err, 'Ошибка получения истории');
                return;
            }
            
            res.json({
                success: true,
                conversations: rows,
                pagination: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    count: rows.length
                }
            });
        });
    } catch (error) {
        handleDbError(res, error, 'Ошибка получения истории');
    }
});

// Поиск по ключевым словам
app.get('/api/cache/search', async (req, res) => {
    try {
        const { keyword, limit = 10 } = req.query;
        
        if (!keyword) {
            return res.status(400).json({ 
                error: 'Параметр keyword обязателен' 
            });
        }

        const query = `
            SELECT DISTINCT c.*, k.weight, k.keyword
            FROM conversations c
            JOIN query_keywords k ON c.id = k.conversation_id
            WHERE k.keyword LIKE ?
            ORDER BY k.weight DESC, c.usage_count DESC
            LIMIT ?
        `;

        dbManager.db.all(query, [`%${keyword}%`, parseInt(limit)], (err, rows) => {
            if (err) {
                handleDbError(res, err, 'Ошибка поиска по ключевым словам');
                return;
            }
            
            res.json({
                success: true,
                results: rows,
                keyword,
                count: rows.length
            });
        });
    } catch (error) {
        handleDbError(res, error, 'Ошибка поиска');
    }
});

// Очистка старых записей
app.delete('/api/cache/cleanup', async (req, res) => {
    try {
        const { daysOld = 30 } = req.body;
        const deletedCount = await dbManager.cleanupOldRecords(daysOld);
        
        res.json({
            success: true,
            deletedCount,
            message: `Удалено ${deletedCount} старых записей`
        });
    } catch (error) {
        handleDbError(res, error, 'Ошибка очистки кэша');
    }
});

// Удаление конкретного разговора
app.delete('/api/cache/conversation/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        dbManager.db.run(
            'DELETE FROM conversations WHERE id = ?',
            [id],
            function(err) {
                if (err) {
                    handleDbError(res, err, 'Ошибка удаления разговора');
                    return;
                }
                
                res.json({
                    success: true,
                    deletedCount: this.changes,
                    message: this.changes > 0 ? 'Разговор удален' : 'Разговор не найден'
                });
            }
        );
    } catch (error) {
        handleDbError(res, error, 'Ошибка удаления');
    }
});

// Получение детальной информации о разговоре
app.get('/api/cache/conversation/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        dbManager.db.get(
            'SELECT * FROM conversations WHERE id = ?',
            [id],
            (err, conversation) => {
                if (err) {
                    handleDbError(res, err, 'Ошибка получения разговора');
                    return;
                }
                
                if (!conversation) {
                    return res.status(404).json({
                        error: 'Разговор не найден'
                    });
                }

                // Получаем ключевые слова для этого разговора
                dbManager.db.all(
                    'SELECT keyword, weight FROM query_keywords WHERE conversation_id = ?',
                    [id],
                    (err, keywords) => {
                        if (err) {
                            console.error('Ошибка получения ключевых слов:', err);
                            keywords = [];
                        }

                        res.json({
                            success: true,
                            conversation: {
                                ...conversation,
                                metadata: conversation.metadata ? JSON.parse(conversation.metadata) : {},
                                keywords: keywords.map(k => ({ word: k.keyword, weight: k.weight }))
                            }
                        });
                    }
                );
            }
        );
    } catch (error) {
        handleDbError(res, error, 'Ошибка получения разговора');
    }
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Обработка 404
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Эндпоинт не найден',
        availableEndpoints: [
            'POST /api/cache/query - Поиск в кэше',
            'POST /api/cache/save - Сохранение в кэш',
            'GET /api/cache/stats - Статистика кэша',
            'GET /api/cache/history - История разговоров',
            'GET /api/cache/search - Поиск по ключевым словам',
            'DELETE /api/cache/cleanup - Очистка старых записей',
            'DELETE /api/cache/conversation/:id - Удаление разговора',
            'GET /api/cache/conversation/:id - Детали разговора'
        ]
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nПолучен сигнал SIGINT. Закрытие сервера...');
    await dbManager.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nПолучен сигнал SIGTERM. Закрытие сервера...');
    await dbManager.close();
    process.exit(0);
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📊 Панель управления: http://localhost:${PORT}`);
    console.log(`🔧 API документация: http://localhost:${PORT}/api`);
});

module.exports = app;
