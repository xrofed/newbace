const express = require('express');
const router = express.Router();
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');
const User = require('../models/User');
const mongoose = require('mongoose');

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Standard Response Format
const successResponse = (res, data, pagination = null) => {
    res.json({
        success: true,
        data,
        pagination
    });
};

const settingsSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: String
});
const Settings = mongoose.model('Settings', settingsSchema);

const errorResponse = (res, message, code = 500) => {
    console.error(`[Error] ${message}`); // Log error ke console server untuk debugging
    res.status(code).json({ success: false, message });
};

// Helper: Kalkulasi Pagination
const getPaginationParams = (req, defaultLimit = 24) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || defaultLimit);
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

// Helper: Optimized Chapter Count (Mencegah N+1 Query Problem)
async function attachChapterCounts(mangas) {
    if (!mangas || mangas.length === 0) return [];

    // 1. Ambil semua ID manga dari list
    const mangaIds = mangas.map(m => m._id);

    // 2. Lakukan 1 kali query Aggregate ke collection Chapter
    const counts = await Chapter.aggregate([
        { $match: { manga_id: { $in: mangaIds } } },
        { $group: { _id: "$manga_id", count: { $sum: 1 } } }
    ]);

    // 3. Buat Map untuk akses cepat (Dictionary)
    const countMap = {};
    counts.forEach(c => {
        countMap[c._id.toString()] = c.count;
    });

    // 4. Gabungkan data
    // Kita asumsikan input 'mangas' sudah berupa Plain Object (karena pakai .lean())
    return mangas.map(m => ({
        ...m,
        chapter_count: countMap[m._id.toString()] || 0
    }));
}

// Helper: Chapter Count + Last Chapter (untuk listing)
async function attachChapterInfo(mangas) {
    if (!mangas || mangas.length === 0) return [];

    const mangaIds = mangas.map(m => m._id);

    const [counts, latestChapters] = await Promise.all([
        Chapter.aggregate([
            { $match: { manga_id: { $in: mangaIds } } },
            { $group: { _id: "$manga_id", count: { $sum: 1 } } }
        ]),
        Chapter.aggregate([
            { $match: { manga_id: { $in: mangaIds } } },
            { $sort: { manga_id: 1, chapter_index: -1, createdAt: -1 } },
            {
                $group: {
                    _id: "$manga_id",
                    chapter: {
                        $first: {
                            title: "$title",
                            slug: "$slug",
                            chapter_index: "$chapter_index",
                            createdAt: "$createdAt"
                        }
                    }
                }
            }
        ])
    ]);

    const countMap = {};
    counts.forEach(c => {
        countMap[c._id.toString()] = c.count;
    });

    const chapterMap = {};
    latestChapters.forEach(c => {
        chapterMap[c._id.toString()] = c.chapter || null;
    });

    return mangas.map(m => ({
        ...m,
        chapter_count: countMap[m._id.toString()] || 0,
        last_chapter: chapterMap[m._id.toString()] || null
    }));
}

// ==========================================
// 1. HOME & LISTING ENDPOINTS
// ==========================================

// GET /api/home 
router.get('/home', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);

        // Jalankan Query Count Total terpisah agar tidak blocking
        const totalMangaPromise = Manga.countDocuments();

        // Query 1: Recents
        const recentsPromise = Manga.find()
            .select('title slug thumb metadata createdAt updatedAt') 
            .sort({ updatedAt: -1 }) 
            .skip(skip)
            .limit(limit)
            .lean(); 

        // Query 2: Trending (Top Views)
        const trendingPromise = Manga.find()
            .select('title slug thumb views metadata')
            .sort({ views: -1 })
            .limit(10)
            .lean();

        // Query 3: Manhwa
        const manhwasPromise = Manga.find({ 'metadata.type': { $regex: 'manhwa', $options: 'i' } })
            .select('title slug thumb metadata updatedAt')
            .sort({ updatedAt: -1 }) 
            .limit(10)
            .lean();

        // Query 4: Manga
        const mangasPromise = Manga.find({ 'metadata.type': { $regex: 'manga', $options: 'i' } })
            .select('title slug thumb metadata updatedAt')
            .sort({ updatedAt: -1 }) 
            .limit(10)
            .lean();

        // Query 5: Doujinshi (BARU)
        const doujinshisPromise = Manga.find({ 'metadata.type': { $regex: 'doujinshi', $options: 'i' } })
            .select('title slug thumb metadata updatedAt')
            .sort({ updatedAt: -1 }) 
            .limit(10)
            .lean();

        // EKSEKUSI PARALEL
        // Tambahkan mangasRaw dan doujinshisRaw di sini
        const [totalManga, recentsRaw, trendingRaw, manhwasRaw, mangasRaw, doujinshisRaw] = await Promise.all([
            totalMangaPromise,
            recentsPromise,
            trendingPromise,
            manhwasPromise,
            mangasPromise,
            doujinshisPromise
        ]);

        // Attach chapter counts secara paralel juga
        // PERBAIKAN: Tambahkan mangas dan doujinshis ke dalam array destructuring
        const [recents, trending, manhwas, mangas, doujinshis] = await Promise.all([
            attachChapterCounts(recentsRaw),
            attachChapterCounts(trendingRaw),
            attachChapterCounts(manhwasRaw),
            attachChapterCounts(mangasRaw),
            attachChapterCounts(doujinshisRaw)
        ]);

        successResponse(res, { 
            recents, 
            trending,
            manhwas,
            mangas,      // Sudah terdefinisi sekarang
            doujinshis   // Kategori baru ditambahkan
        }, {
            currentPage: page,
            totalPages: Math.ceil(totalManga / limit),
            totalItems: totalManga,
            perPage: limit
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 1. UTAMA: ADVANCED FILTER & SEARCH (GET /manga)
// ==========================================
router.get('/manga-list', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);
        // 1. Tambahkan 'order' dalam destructuring query
        const { q, status, type, genre, order } = req.query;

        // Bangun Query Object Dinamis
        let query = {};

        // Filter Search (Title)
        if (q) {
            query.title = { $regex: q, $options: 'i' };
        }

        // Filter Status (Publishing/Finished)
        if (status && status !== 'all') {
            query['metadata.status'] = { $regex: new RegExp(`^${status}$`, 'i') };
        }

        // Filter Type (Manga/Manhwa/Doujinshi)
        if (type && type !== 'all') {
            query['metadata.type'] = { $regex: new RegExp(`^${type}$`, 'i') };
        }

        // Filter Genre
        if (genre && genre !== 'all') {
            const cleanGenre = genre.replace(/-/g, '[\\s\\-]');
            query.tags = { $regex: new RegExp(cleanGenre, 'i') };
        }

        // --- 2. LOGIKA SORTING BARU ---
        let sortOption = { updatedAt: -1 }; // Default: Terbaru

        switch (order) {
            case 'oldest':
                sortOption = { updatedAt: 1 }; // Terlama (Ascending)
                break;
            case 'popular':
                sortOption = { views: -1 }; // Terpopuler (Views terbanyak)
                break;
            case 'az':
                sortOption = { title: 1 }; // Abjad A-Z
                break;
            case 'za':
                sortOption = { title: -1 }; // Abjad Z-A
                break;
            default:
                sortOption = { updatedAt: -1 }; // Terbaru (Default)
        }

        // Eksekusi Query
        const total = await Manga.countDocuments(query);
        
        const mangasRaw = await Manga.find(query)
            .select('title slug thumb metadata views rating status type tags updatedAt') 
            .sort(sortOption) // 3. Gunakan variabel sortOption disini
            .skip(skip)
            .limit(limit)
            .lean();

        // Attach info tambahan (Chapter Count & Last Chapter)
        const mangas = await attachChapterInfo(mangasRaw);

        successResponse(res, mangas, {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            perPage: limit
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 2. DETAIL & READ ENDPOINTS
// ==========================================

// GET /api/manga/:slug
router.get('/manga/:slug', async (req, res) => {
    try {
        // Cari dan update view sekalian ambil datanya
        const manga = await Manga.findOneAndUpdate(
            { slug: req.params.slug },
            { $inc: { views: 1 } },
            { new: true, timestamps: false }
        ).lean();

        if (!manga) return errorResponse(res, 'Manga not found', 404);

        // 1. Siapkan Promise untuk mencari Chapter
        const chaptersPromise = Chapter.find({ manga_id: manga._id })
            .select('title slug chapter_index createdAt')
            // Gunakan -1 untuk Descending (Chapter Terbesar/Terbaru paling atas)
            .sort({ chapter_index: -1 }) 
            // PENTING: Tambahkan collation agar sorting angka akurat
            .collation({ locale: "en_US", numericOrdering: true })
            .lean();

        // 2. Siapkan Promise untuk mencari 6 Rekomendasi Random
        const recommendationsPromise = Manga.aggregate([
            { $match: { _id: { $ne: manga._id } } }, // Kecualikan manga yang sedang dibuka ini
            { $sample: { size: 6 } },                // Ambil 6 dokumen secara acak
            { $project: { title: 1, slug: 1, thumb: 1, metadata: 1, views: 1 } } // Ambil field yang penting saja untuk card
        ]);

        // 3. Jalankan kedua Promise secara bersamaan (Paralel) agar lebih cepat
        const [chapters, rawRecommendations] = await Promise.all([
            chaptersPromise,
            recommendationsPromise
        ]);

        // (Opsional) Attach chapter counts ke rekomendasi jika kamu butuh menampilkan jumlah chapter di card rekomendasi
        // Fungsi attachChapterCounts ini sudah ada di file api.js kamu
        const recommendations = await attachChapterCounts(rawRecommendations);

        // Gabungkan manual karena sudah .lean()
        manga.chapter_count = chapters.length;

        // 4. Kirim response dengan tambahan data recommendations
        successResponse(res, { 
            info: manga, 
            chapters, 
            recommendations 
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});


// GET /api/read/:slug/:chapterSlug
router.get('/read/:slug/:chapterSlug', async (req, res) => {
    try {
        const manga = await Manga.findOne({ slug: req.params.slug })
            .select('_id title slug thumb')
            .lean();
            
        if (!manga) return errorResponse(res, 'Manga not found', 404);

        const chapter = await Chapter.findOne({ 
            manga_id: manga._id, 
            slug: req.params.chapterSlug 
        }).lean();

        if (!chapter) return errorResponse(res, 'Chapter not found', 404);
        const [nextChap, prevChap] = await Promise.all([
            Chapter.findOne({ 
                manga_id: manga._id, 
                chapter_index: { $gt: chapter.chapter_index } 
            })
            .sort({ chapter_index: 1 })
            .select('slug title')
            .collation({ locale: "en_US", numericOrdering: true }) 
            .lean(),
            Chapter.findOne({ 
                manga_id: manga._id, 
                chapter_index: { $lt: chapter.chapter_index } 
            })
            .sort({ chapter_index: -1 })
            .select('slug title')
            .collation({ locale: "en_US", numericOrdering: true })
            .lean()
        ]);
        successResponse(res, { 
            chapter, 
            manga, 
            navigation: {
                next: nextChap ? nextChap.slug : null,
                prev: prevChap ? prevChap.slug : null
            }
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});


// ==========================================
// 3. SEARCH & FILTERS
// ==========================================

// GET /api/search?q=keyword
router.get('/search', async (req, res) => {
    try {
        const keyword = req.query.q;
        if (!keyword) return errorResponse(res, 'Query parameter "q" required', 400);

        const { page, limit, skip } = getPaginationParams(req);
        const query = { title: { $regex: keyword, $options: 'i' } };

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(query),
            Manga.find(query)
                .select('title slug thumb metadata')
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        const mangas = await attachChapterCounts(mangasRaw);

        successResponse(res, mangas, {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            perPage: limit
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/genres
router.get('/genres', async (req, res) => {
    try {
        // Ambil genre unik dari semua manga
        const genres = await Manga.aggregate([
            { $unwind: "$tags" }, // Pecah array tags menjadi dokumen terpisah
            // Filter tags kosong jika ada
            { $match: { tags: { $ne: "" } } }, 
            { $group: { _id: "$tags", count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);
        
        // Format output agar lebih bersih: [{name: "Action", count: 10}, ...]
        const formattedGenres = genres.map(g => ({ name: g._id, count: g.count }));
        
        successResponse(res, formattedGenres);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/filter/:type/:value
router.get('/filter/:type/:value', async (req, res) => {
    try {
        const { type, value } = req.params;
        const { page, limit, skip } = getPaginationParams(req);

        let query = {};

        if (type === 'genre') {
            const cleanValue = value.replace(/-/g, '[\\s\\-]'); 
            query = { tags: { $regex: new RegExp(cleanValue, 'i') } };
        } else if (type === 'status') {
            query = { 'metadata.status': { $regex: `^${value}$`, $options: 'i' } };
        } else if (type === 'type') {
            query = { 'metadata.type': { $regex: `^${value}$`, $options: 'i' } };
        } else {
            return errorResponse(res, 'Invalid filter type. Use: genre, status, or type.', 400);
        }

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(query),
            Manga.find(query)
                .sort({ updatedAt: -1 })
                .select('title slug thumb metadata updatedAt')
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        const mangas = await attachChapterCounts(mangasRaw);

        successResponse(res, mangas, {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            filter: { type, value },
            perPage: limit
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// POST /api/users/sync
// Mendapatkan data user, mengecek masa aktif premium, dan reset limit harian
router.post('/users/sync', async (req, res) => {
    try {
        const { googleId, email, displayName, photoURL } = req.body;
        if (!googleId) return errorResponse(res, 'googleId is required', 400);

        // ==========================================
        // LOGIKA ADMIN: Taruh UID kamu di dalam array ini
        // ==========================================
        const ADMIN_UIDS = ['BUkIZguy10hnIG8jAooZoycG7ak1']; 
        const isUserAdmin = ADMIN_UIDS.includes(googleId);

        let user = await User.findOne({ googleId });
        const today = new Date().toISOString().split('T')[0];
        
        // 1. JIKA USER BARU
        if (!user) {
            user = new User({ 
                googleId, 
                email, 
                displayName,
                photoURL: photoURL || '',
                isAdmin: isUserAdmin,
                isPremium: isUserAdmin,
                dailyDownloads: { date: today, count: 0 } 
            });
        } else {
            // 2. JIKA USER LAMA — update info profil terbaru dari Firebase Auth
            user.isAdmin = isUserAdmin;
            if (displayName) user.displayName = displayName;
            if (photoURL) user.photoURL = photoURL;

            if (isUserAdmin) {
                user.isPremium = true;
            } else if (user.isPremium && user.premiumUntil) {
                if (new Date() > user.premiumUntil) {
                    user.isPremium = false;
                    user.premiumUntil = null;
                }
            }

            // Logika Reset Limit Download
            if (!user.dailyDownloads) {
                user.dailyDownloads = { date: today, count: 0 };
            } else if (user.dailyDownloads.date !== today) {
                user.dailyDownloads.date = today;
                user.dailyDownloads.count = 0;
            }
        }

        await user.save();
        successResponse(res, user);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 4. USER READ ENDPOINTS
// ==========================================

// GET /api/users/:googleId
// Mengambil data lengkap seorang user
router.get('/users/:googleId', async (req, res) => {
    try {
        const { googleId } = req.params;
        const user = await User.findOne({ googleId }).lean();
        if (!user) return errorResponse(res, 'User not found', 404);
        successResponse(res, user);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/users/:googleId/library
// Mengambil semua item library milik user
router.get('/users/:googleId/library', async (req, res) => {
    try {
        const { googleId } = req.params;
        const user = await User.findOne({ googleId }).select('library').lean();
        if (!user) return errorResponse(res, 'User not found', 404);
        // Urutkan dari yang terbaru ditambahkan
        const sorted = (user.library || []).sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
        successResponse(res, sorted);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/users/:googleId/history
// Mengambil semua riwayat bacaan user
router.get('/users/:googleId/history', async (req, res) => {
    try {
        const { googleId } = req.params;
        const user = await User.findOne({ googleId }).select('history').lean();
        if (!user) return errorResponse(res, 'User not found', 404);
        // Urutkan dari yang paling baru dibaca
        const sorted = (user.history || []).sort((a, b) => new Date(b.lastRead) - new Date(a.lastRead));
        successResponse(res, sorted);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/users/:googleId/public-profile
// Profil publik user — digunakan di halaman /user/[userId] Next.js
router.get('/users/:googleId/public-profile', async (req, res) => {
    try {
        const { googleId } = req.params;
        const user = await User.findOne({ googleId })
            // TAMBAHAN: Masukkan isPremium dan isAdmin ke dalam select()
            .select('googleId displayName photoURL bio library isPremium isAdmin')
            .lean();
            
        if (!user) return errorResponse(res, 'User not found', 404);

        // Hitung stats dari library
        const library = user.library || [];
        const stats = library.reduce((acc, item) => {
            const status = item.mangaData?.readingStatus || 'reading';
            acc[status] = (acc[status] || 0) + 1;
            return acc;
        }, {});

        successResponse(res, {
            googleId: user.googleId,
            displayName: user.displayName || '',
            photoURL: user.photoURL || '',
            bio: user.bio || '',
            // TAMBAHAN: Kirimkan status premium dan admin ke frontend
            isPremium: user.isPremium || false,
            isAdmin: user.isAdmin || false,
            library,
            stats: {
                reading:  stats.reading  || 0,
                to_read:  stats.to_read  || 0,
                finished: stats.finished || 0,
                dropped:  stats.dropped  || 0,
                total: library.length,
            }
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// PATCH /api/users/:googleId/bio
// Update bio user (maks 100 karakter)
router.patch('/users/:googleId/bio', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { bio } = req.body;
        if (bio === undefined) return errorResponse(res, 'bio is required', 400);
        const user = await User.findOneAndUpdate(
            { googleId },
            { bio: String(bio).trim().substring(0, 100) },
            { new: true }
        ).lean();
        if (!user) return errorResponse(res, 'User not found', 404);
        successResponse(res, { bio: user.bio });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// POST /api/users/:googleId/library
// Menambah atau memperbarui manga di Library
router.post('/users/:googleId/library', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { slug, mangaData } = req.body;

        if (!slug) return errorResponse(res, 'slug is required', 400);

        const user = await User.findOne({ googleId });
        if (!user) return errorResponse(res, 'User not found', 404);

        // Cek apakah manga sudah ada di library
        const existingIndex = user.library.findIndex(item => item.slug === slug);

        if (existingIndex >= 0) {
            // Jika sudah ada, perbarui data manga dan waktu ditambahkan
            user.library[existingIndex].mangaData = mangaData;
            user.library[existingIndex].addedAt = Date.now();
        } else {
            // Jika belum ada, masukkan ke dalam array library
            user.library.push({ slug, mangaData });
        }

        await user.save();
        successResponse(res, user.library);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// POST /api/users/:googleId/history
// Mencatat atau memperbarui riwayat bacaan
router.post('/users/:googleId/history', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { type, slug, title, thumb, lastChapterTitle, lastChapterSlug } = req.body;

        if (!slug) return errorResponse(res, 'slug is required', 400);

        const user = await User.findOne({ googleId });
        if (!user) return errorResponse(res, 'User not found', 404);

        // Cek apakah manga ini sudah ada di history sebelumnya
        const existingIndex = user.history.findIndex(item => item.slug === slug);

        if (existingIndex >= 0) {
            // Jika sudah ada, cukup update chapter terakhir dan waktu bacanya
            user.history[existingIndex].lastChapterTitle = lastChapterTitle;
            user.history[existingIndex].lastChapterSlug = lastChapterSlug;
            user.history[existingIndex].lastRead = Date.now();
            // Update detail lain jika disediakan
            if (title) user.history[existingIndex].title = title;
            if (thumb) user.history[existingIndex].thumb = thumb;
        } else {
            // Jika belum ada, tambahkan history baru
            user.history.push({
                type, slug, title, thumb, lastChapterTitle, lastChapterSlug
            });
        }

        await user.save();
        successResponse(res, user.history);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 5. USER DELETE ENDPOINTS
// ==========================================

// DELETE /api/users/:googleId/library/:slug
// Menghapus satu manga secara spesifik dari Library
router.delete('/users/:googleId/library/:slug', async (req, res) => {
    try {
        const { googleId, slug } = req.params;
        const user = await User.findOne({ googleId });
        
        if (!user) return errorResponse(res, 'User not found', 404);

        // Hapus manga dengan slug yang cocok dari array library
        user.library = user.library.filter(item => item.slug !== slug);
        await user.save();

        successResponse(res, { message: 'Manga berhasil dihapus dari library' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// DELETE /api/users/:googleId/library
// Menghapus SEMUA manga dari Library (Clear Library)
router.delete('/users/:googleId/library', async (req, res) => {
    try {
        const { googleId } = req.params;
        const user = await User.findOne({ googleId });
        
        if (!user) return errorResponse(res, 'User not found', 404);

        // Kosongkan array library
        user.library = [];
        await user.save();

        successResponse(res, { message: 'Library berhasil dikosongkan' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// DELETE /api/users/:googleId/history/:slug
// Menghapus satu riwayat bacaan secara spesifik
router.delete('/users/:googleId/history/:slug', async (req, res) => {
    try {
        const { googleId, slug } = req.params;
        const user = await User.findOne({ googleId });
        
        if (!user) return errorResponse(res, 'User not found', 404);

        // Hapus history dengan slug yang cocok
        user.history = user.history.filter(item => item.slug !== slug);
        await user.save();

        successResponse(res, { message: 'Riwayat bacaan berhasil dihapus' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// DELETE /api/users/:googleId/history
// Menghapus SEMUA riwayat bacaan, bisa difilter berdasarkan tipe (?type=manga)
router.delete('/users/:googleId/history', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { type } = req.query; // Ambil tipe dari query parameter
        const user = await User.findOne({ googleId });
        
        if (!user) return errorResponse(res, 'User not found', 404);

        if (type) {
            // Jika ada tipe spesifik (misal hanya mau hapus history 'manga'), 
            // simpan yang tipenya TIDAK SAMA dengan yang mau dihapus
            user.history = user.history.filter(item => item.type !== type);
        } else {
            // Jika tidak ada tipe, kosongkan semua history
            user.history = [];
        }
        
        await user.save();

        successResponse(res, { message: 'Riwayat bacaan berhasil dibersihkan' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 6. DOWNLOAD LIMIT & PREMIUM ENDPOINTS
// ==========================================

// POST /api/users/:googleId/download
// Mengecek limit dan menambahkan hitungan download harian
router.post('/users/:googleId/download', async (req, res) => {
    try {
        const { googleId } = req.params;
        const user = await User.findOne({ googleId });
        if (!user) return errorResponse(res, 'User not found', 404);

        // 1. Cek Kadaluarsa Premium (Khusus untuk user biasa / bukan admin)
        if (!user.isAdmin && user.isPremium && user.premiumUntil) {
            // Jika hari ini sudah melewati tanggal premiumUntil, matikan premiumnya
            if (new Date() > user.premiumUntil) {
                user.isPremium = false;
                user.premiumUntil = null;
            }
        }

        // Jika user masih Premium ATAU Admin, langsung loloskan tanpa limit
        if (user.isPremium || user.isAdmin) { 
            await user.save(); // Simpan jika ada perubahan status kadaluarsa
            return successResponse(res, { allowed: true, isPremium: true });
        }

        // 2. Logika Limit User Biasa (20x Sehari)
        const today = new Date().toISOString().split('T')[0]; // Mendapatkan tanggal "YYYY-MM-DD"
        const MAX_LIMIT = 20;

        // Pastikan object dailyDownloads ada, jika tidak, buat struktur default-nya
        if (!user.dailyDownloads) {
            user.dailyDownloads = { date: "", count: 0 };
        }

        // Jika tanggal di database beda dengan hari ini, reset hitungan jadi 0
        if (user.dailyDownloads.date !== today) {
            user.dailyDownloads.date = today;
            user.dailyDownloads.count = 0;
        }

        // Jika sudah mencapai batas
        if (user.dailyDownloads.count >= MAX_LIMIT) {
            await user.save();
            return successResponse(res, { 
                allowed: false, 
                current: user.dailyDownloads.count, 
                max: MAX_LIMIT,
                message: "Batas unduhan harian (20) tercapai. Tunggu besok atau upgrade Premium!"
            });
        }

        // 3. Tambah hitungan jika belum limit
        user.dailyDownloads.count += 1;
        user.downloadCount += 1; // Total seumur hidup
        await user.save();

        successResponse(res, { 
            allowed: true, 
            current: user.dailyDownloads.count, 
            max: MAX_LIMIT 
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// POST /api/users/:googleId/set-premium
// Rute Khusus Admin untuk memberikan Premium (Misal: 7 hari, 30 hari)
router.post('/users/:googleId/set-premium', async (req, res) => {
    try {
        const { googleId } = req.params;
        const { days } = req.body; // Jumlah hari premium dari Flutter

        if (!days) return errorResponse(res, 'Jumlah hari (days) diperlukan', 400);

        const user = await User.findOne({ googleId });
        if (!user) return errorResponse(res, 'User not found', 404);

        // 1. Set Status Premium
        user.isPremium = true;
        
        // 2. Hitung tanggal kadaluarsa dari hari ini + jumlah hari (Cukup tulis SATU KALI saja)
        const expDate = new Date();
        expDate.setDate(expDate.getDate() + parseInt(days));
        user.premiumUntil = expDate;

        // 3. Tambahkan Notifikasi ke User
        if (!user.notifications) user.notifications = [];
        user.notifications.push({
            title: "Premium Diaktifkan! 🎉",
            message: `Admin telah mengaktifkan status Premium kamu selama ${days} hari. Nikmati fitur unduhan tanpa batas!`,
            isRead: false,
            createdAt: new Date() // <-- PENTING: Tambahkan timestamp untuk sorting
        });

        // 4. Simpan ke Database
        await user.save();
        
        successResponse(res, { 
            message: `Premium berhasil diaktifkan selama ${days} hari`, 
            premiumUntil: user.premiumUntil 
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 8. ADMIN ENDPOINTS
// ==========================================

// Middleware untuk memverifikasi apakah user adalah admin
const isAdmin = async (req, res, next) => {
    // Ambil adminId dari body request untuk verifikasi
    const { adminId } = req.body;
    const ADMIN_UIDS = ['BUkIZguy10hnIG8jAooZoycG7ak1']; // Pastikan UID admin Anda ada di sini

    if (!adminId || !ADMIN_UIDS.includes(adminId)) {
        return errorResponse(res, 'Akses ditolak. Hanya untuk Admin.', 403);
    }
    // Jika lolos, lanjutkan ke fungsi selanjutnya
    next();
};

// POST /api/admin/broadcast
// Mengirim notifikasi ke semua user
router.post('/admin/broadcast', isAdmin, async (req, res) => {
    try {
        const { title, message } = req.body;

        if (!title || !message) {
            return errorResponse(res, 'Judul dan pesan tidak boleh kosong', 400);
        }

        const newNotification = {
            title,
            message,
            isRead: false,
            createdAt: new Date()
        };

        // Menggunakan updateMany untuk menambahkan notifikasi ke SEMUA user
        const result = await User.updateMany(
            {}, // Filter kosong berarti memilih semua dokumen (user)
            { $push: { notifications: newNotification } }
        );

        successResponse(res, {
            message: `Notifikasi berhasil dikirim ke ${result.modifiedCount} user.`
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 7. NOTIFICATION ENDPOINTS
// ==========================================

// GET /api/users/:googleId/notifications
// Mengambil semua notifikasi untuk seorang user
router.get('/users/:googleId/notifications', async (req, res) => {
    try {
        const { googleId } = req.params;
        // Ambil hanya field notifikasi untuk efisiensi
        const user = await User.findOne({ googleId }).select('notifications').lean();
        
        if (!user) return errorResponse(res, 'User not found', 404);

        // Urutkan notifikasi dari yang terbaru ke terlama sebelum mengirim
        const sortedNotifications = (user.notifications || []).sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );

        successResponse(res, sortedNotifications);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// PUT /api/users/:googleId/notifications/read
// Menandai semua notifikasi sebagai sudah dibaca
router.put('/users/:googleId/notifications/read', async (req, res) => {
    try {
        const { googleId } = req.params;
        // Update semua item dalam array notifikasi, set isRead menjadi true
        await User.updateOne({ googleId }, { $set: { "notifications.$[].isRead": true } });
        successResponse(res, { message: 'All notifications marked as read' });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET: Mengambil Nomor WhatsApp Admin
router.get('/settings/whatsapp', async (req, res) => {
    try {
        let setting = await Settings.findOne({ key: 'whatsapp' });
        // Jika belum ada di database, kembalikan nomor default
        res.json({ success: true, whatsapp: setting ? setting.value : '6281234567890' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST: Mengubah Nomor WhatsApp Admin
router.post('/settings/whatsapp', async (req, res) => {
    try {
        const { whatsapp } = req.body;
        let setting = await Settings.findOne({ key: 'whatsapp' });
        
        if (!setting) {
            setting = new Settings({ key: 'whatsapp', value: whatsapp });
        } else {
            setting.value = whatsapp;
        }
        
        await setting.save();
        res.json({ success: true, whatsapp: setting.value });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
