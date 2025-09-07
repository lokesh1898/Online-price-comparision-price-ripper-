// server.js - SmartSpend AI Backend

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer'); // For handling file uploads
const sqlite3 = require('sqlite3').verbose(); // For SQLite database
const nodemailer = require('nodemailer'); // For sending emails
const bcrypt = require('bcrypt'); // For password hashing

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json()); // To parse JSON request bodies

// IMPORTANT: Replace with your actual SerpAPI Key
const SERP_API_KEY = process.env.SERP_API_KEY || '68faa49da29c44e4b8e41ac2c6f75f816fa78c5183ffc0309e6cbe945f8383c7';

// --- Database Setup ---
// The database file will be created in the project root if it doesn't exist
const db = new sqlite3.Database('./smartspend.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the smartspend.db SQLite database.');
        // Create tables if they don't exist
        db.serialize(() => { // Use serialize to ensure commands run in order
            db.run(`CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                thumbnail TEXT,
                link TEXT NOT NULL,
                source TEXT,
                last_price TEXT,
                last_updated INTEGER
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS price_history (
                product_id TEXT NOT NULL,
                price TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (product_id) REFERENCES products(id)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS wishlists (
                user_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, product_id),
                FOREIGN KEY (product_id) REFERENCES products(id)
            )`);
            // Customers table for registration/login
            db.run(`CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )`);
            // Cart table for user carts and price reminders
            db.run(`CREATE TABLE IF NOT EXISTS cart (
                user_id INTEGER NOT NULL, -- Changed to INTEGER to match customers.id
                product_id TEXT NOT NULL,
                reminder_price TEXT,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, product_id),
                FOREIGN KEY (user_id) REFERENCES customers(id),
                FOREIGN KEY (product_id) REFERENCES products(id)
            )`);
            console.log('Database tables checked/created.');
        });
    }
});

// --- Multer Setup for Image Uploads ---
const upload = multer({
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB file size limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

// --- Helper Function: Perform SerpAPI Search ---
async function performSerpApiSearch(query) {
    if (!SERP_API_KEY) {
        throw new Error("Server configuration error: SerpAPI Key is missing. Please set it in your environment variables.");
    }

    console.log('Starting search for query:', query);

    // First try Google Shopping as it's usually the most reliable
    try {
        const googleUrl = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&location=India&google_domain=google.co.in&gl=in&hl=en&api_key=${SERP_API_KEY}`;
        console.log('Fetching from Google Shopping...');
        
        const response = await axios.get(googleUrl, { timeout: 15000 });
        console.log('Google Shopping response received');
        
        if (response.data && response.data.shopping_results) {
            console.log(`Found ${response.data.shopping_results.length} results from Google Shopping`);
            const products = response.data.shopping_results.map(item => ({
                id: Buffer.from(`${item.title}-${item.source}-${item.product_link}`).toString('base64'),
                title: item.title,
                price: item.price,
                link: item.product_link,
                source: item.source,
                thumbnail: item.thumbnail,
                rating: item.rating // Include rating from SerpAPI
            }));

            // Store products in database
            for (const product of products) {
                db.run(`INSERT OR REPLACE INTO products (id, title, thumbnail, link, source, last_price, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [product.id, product.title, product.thumbnail, product.link, product.source, product.price, Date.now()],
                    function(err) {
                        if (err) {
                            console.error('Error storing product:', err.message);
                        } else {
                            db.run(`INSERT INTO price_history (product_id, price, timestamp) VALUES (?, ?, ?)`,
                                [product.id, product.price, Date.now()],
                                function(err) {
                                    if (err) console.error('Error storing price history:', err.message);
                                }
                            );
                        }
                    }
                );
            }

            // Add predictions
            for (const product of products) {
                product.prediction = await getPricePrediction(product.id, product.price);
                // Format price in INR
                if (product.price && !product.price.includes('₹')) {
                    product.price = '₹' + parseFloat(product.price.replace(/[^0-9.]/g, '')).toFixed(2);
                }
            }

            // Filter and sort
            return filterAndSortProducts(products, query);
        }
    } catch (error) {
        console.error('Error fetching from Google Shopping:', error.message);
    }

    // If Google Shopping fails, try Amazon
    try {
        const amazonUrl = `https://serpapi.com/search.json?engine=amazon&q=${encodeURIComponent(query)}&gl=in&hl=en&api_key=${SERP_API_KEY}`;
        console.log('Fetching from Amazon...');
        
        const response = await axios.get(amazonUrl, { timeout: 15000 });
        console.log('Amazon response received');
        
        if (response.data && response.data.product_results) {
            console.log(`Found ${response.data.product_results.length} results from Amazon`);
            const products = response.data.product_results.map(item => ({
                id: Buffer.from(`${item.title}-Amazon-${item.link}`).toString('base64'),
                title: item.title,
                price: item.price,
                link: item.link,
                source: 'Amazon',
                thumbnail: item.thumbnail || item.image,
                rating: item.rating // Include rating from SerpAPI
            }));

            // Store products in database
            for (const product of products) {
                db.run(`INSERT OR REPLACE INTO products (id, title, thumbnail, link, source, last_price, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [product.id, product.title, product.thumbnail, product.link, product.source, product.price, Date.now()],
                    function(err) {
                        if (err) {
                            console.error('Error storing product:', err.message);
                        } else {
                            db.run(`INSERT INTO price_history (product_id, price, timestamp) VALUES (?, ?, ?)`,
                                [product.id, product.price, Date.now()],
                                function(err) {
                                    if (err) console.error('Error storing price history:', err.message);
                                }
                            );
                        }
                    }
                );
            }

            // Add predictions
            for (const product of products) {
                product.prediction = await getPricePrediction(product.id, product.price);
                // Format price in INR
                if (product.price && !product.price.includes('₹')) {
                    product.price = '₹' + parseFloat(product.price.replace(/[^0-9.]/g, '')).toFixed(2);
                }
            }

            // Filter and sort
            return filterAndSortProducts(products, query);
        }
    } catch (error) {
        console.error('Error fetching from Amazon:', error.message);
    }

    // If both fail, try eBay
    try {
        const ebayUrl = `https://serpapi.com/search.json?engine=ebay&q=${encodeURIComponent(query)}&gl=in&hl=en&api_key=${SERP_API_KEY}`;
        console.log('Fetching from eBay...');
        
        const response = await axios.get(ebayUrl, { timeout: 15000 });
        console.log('eBay response received');
        
        if (response.data && response.data.organic_results) {
            console.log(`Found ${response.data.organic_results.length} results from eBay`);
            const products = response.data.organic_results
                .filter(item => item.price && item.thumbnail)
                .map(item => ({
                    id: Buffer.from(`${item.title}-eBay-${item.link}`).toString('base64'),
                    title: item.title,
                    price: item.price,
                    link: item.link,
                    source: 'eBay',
                    thumbnail: item.thumbnail,
                    rating: item.rating || 0 // eBay results might not have rating, default to 0
                }));

            // Store products in database
            for (const product of products) {
                db.run(`INSERT OR REPLACE INTO products (id, title, thumbnail, link, source, last_price, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [product.id, product.title, product.thumbnail, product.link, product.source, product.price, Date.now()],
                    function(err) {
                        if (err) {
                            console.error('Error storing product:', err.message);
                        } else {
                            db.run(`INSERT INTO price_history (product_id, price, timestamp) VALUES (?, ?, ?)`,
                                [product.id, product.price, Date.now()],
                                function(err) {
                                    if (err) console.error('Error storing price history:', err.message);
                                }
                            );
                        }
                    }
                );
            }

            // Add predictions
            for (const product of products) {
                product.prediction = await getPricePrediction(product.id, product.price);
                // Format price in INR
                if (product.price && !product.price.includes('₹')) {
                    product.price = '₹' + parseFloat(product.price.replace(/[^0-9.]/g, '')).toFixed(2);
                }
            }

            // Filter and sort
            return filterAndSortProducts(products, query);
        }
    } catch (error) {
        console.error('Error fetching from eBay:', error.message);
    }

    throw new Error('No products found from any source. Please try a different search term.');
}

// --- Helper Function: Simulate Price Prediction ---
async function getPricePrediction(productId, currentPrice) {
    return new Promise((resolve) => {
        db.all(`SELECT price FROM price_history WHERE product_id = ? ORDER BY timestamp DESC LIMIT 5`, [productId], (err, rows) => {
            if (err) {
                console.error('Error fetching price history for prediction:', err.message);
                return resolve('neutral'); // Default to neutral on error
            }

            if (rows.length < 3) { // Not enough data for a meaningful prediction
                return resolve('neutral');
            }

            const prices = rows.map(row => parseFloat(row.price.replace(/[^0-9.]/g, ''))).filter(p => !isNaN(p));
            if (prices.length < 3) {
                return resolve('neutral');
            }

            const latestPrice = parseFloat(currentPrice.replace(/[^0-9.]/g, ''));
            const averageRecent = prices.reduce((sum, p) => sum + p, 0) / prices.length;
            const minPrice = Math.min(...prices);
            const maxPrice = Math.max(...prices);

            // Simple prediction logic:
            if (latestPrice <= minPrice * 1.05) { // Current price is near or below recent min
                resolve('buy');
            } else if (latestPrice >= maxPrice * 0.95) { // Current price is near or above recent max
                resolve('wait');
            } else if (latestPrice < averageRecent * 0.98) { // Current price is slightly below average
                resolve('buy');
            } else if (latestPrice > averageRecent * 1.02) { // Current price is slightly above average
                resolve('wait');
            } else {
                resolve('neutral');
            }
        });
    });
}

// --- Helper: Filter and Sort Products for Relevance ---
function filterAndSortProducts(products, query) {
    // Keywords to deprioritize (cases, covers, etc.)
    const accessoryKeywords = ['case', 'cover', 'screen protector', 'tempered glass', 'skin', 'pouch', 'stand', 'holder', 'strap', 'charger', 'cable', 'adapter', 'earbuds', 'headphones', 'protector', 'bag', 'back cover', 'flip cover', 'bumper', 'shell', 'guard'];
    // Phones first, then accessories
    const isAccessory = (title) => accessoryKeywords.some(k => title.toLowerCase().includes(k));
    // Phones: title contains query words, not accessory
    const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 0); // Filter out empty strings
    const isRelevant = (title) => queryWords.every(qw => title.toLowerCase().includes(qw)) && !isAccessory(title);
    // Sort: relevant phones, then others, then by price ascending
    products.sort((a, b) => {
        const aRelevant = isRelevant(a.title);
        const bRelevant = isRelevant(b.title);
        if (aRelevant && !bRelevant) return -1;
        if (!aRelevant && bRelevant) return 1;
        // If both same relevance, sort by price (converted to number)
        const aPrice = parseFloat((a.price || '').replace(/[^0-9.]/g, '')) || Infinity;
        const bPrice = parseFloat((b.price || '').replace(/[^0-9.]/g, '')) || Infinity;
        return aPrice - bPrice;
    });
    return products;
}

// --- Routes ---

// Serve static files (like your style.css) from the current directory
app.use(express.static(__dirname));

// Route to serve index.html for the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint for Text-based Product Search
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: 'Query parameter "q" is required.' });
    }

    console.log('Received search request for:', query);

    try {
        const products = await performSerpApiSearch(query);
        console.log(`Found ${products.length} products`);
        
        if (products.length === 0) {
            return res.status(404).json({ error: 'No products found. Try a different search term.' });
        }
        
        res.json(products);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message || 'An error occurred while searching.' });
    }
});

// Endpoint for Image-based Product Search
app.post('/search-by-image', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded.' });
    }

    console.log('Received image for analysis:', req.file.originalname);
    let extractedSearchQuery = '';

    // --- START OF IMAGE RECOGNITION SIMULATION ---
    // In a real application, you would send req.file.buffer (the image data)
    // to an actual image recognition API (e.g., Google Cloud Vision API, Clarifai, etc.).
    // This API would process the image and return relevant text or product names.

    // For demonstration, we'll simulate based on file name or a default.
    const lowerCaseFileName = req.file.originalname.toLowerCase();
    if (lowerCaseFileName.includes('samsung') && lowerCaseFileName.includes('s25')) {
        extractedSearchQuery = 'Samsung Galaxy S25';
    } else if (lowerCaseFileName.includes('iphone')) {
        extractedSearchQuery = 'iPhone 15';
    } else if (lowerCaseFileName.includes('laptop') || lowerCaseFileName.includes('computer')) {
        extractedSearchQuery = 'Laptop';
    } else if (lowerCaseFileName.includes('shoe') || lowerCaseFileName.includes('sneaker')) {
        extractedSearchQuery = 'running shoes';
    } else if (lowerCaseFileName.includes('watch')) {
        extractedSearchQuery = 'smartwatch';
    }
    else {
        extractedSearchQuery = 'electronics product'; // Default fallback
    }

    console.log(`Simulated image recognition: Found "${extractedSearchQuery}"`);
    // --- END OF IMAGE RECOGNITION SIMULATION ---

    if (!extractedSearchQuery) {
        return res.status(400).json({ error: 'Could not identify a product from the image. Please try a different image or use text search.' });
    }

    try {
        const products = await performSerpApiSearch(extractedSearchQuery);
        if (products.length === 0) {
            return res.status(404).json({ error: 'No products found for the image. Try a different image.' });
        }
        res.json(products);
    } catch (error) {
        console.error('Error in image search:', error);
        res.status(500).json({ error: error.message || 'An error occurred while processing the image.' });
    }
});

// --- Wishlist Endpoints ---

// Add product to wishlist
app.post('/wishlist/add', (req, res) => {
    const { userId, productId } = req.body;
    if (!userId || !productId) {
        return res.status(400).json({ error: 'User ID and Product ID are required.' });
    }

    db.run(`INSERT OR IGNORE INTO wishlists (user_id, product_id, added_at) VALUES (?, ?, ?)`,
        [userId, productId, Date.now()],
        function(err) {
            if (err) {
                console.error('Error adding to wishlist:', err.message);
                return res.status(500).json({ error: 'Failed to add to wishlist.' });
            }
            res.json({ message: this.changes > 0 ? 'Added to wishlist.' : 'Already in wishlist.' });
        }
    );
});

// Get user's wishlist
app.get('/wishlist', (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ error: 'User ID is required.' });
    }

    db.all(`SELECT p.*, w.added_at FROM wishlists w JOIN products p ON w.product_id = p.id WHERE w.user_id = ?`, [userId], async (err, rows) => {
        if (err) {
            console.error('Error fetching wishlist:', err.message);
            return res.status(500).json({ error: 'Failed to fetch wishlist.' });
        }
        // Add current prediction to each wishlisted product
        for (const product of rows) {
            product.prediction = await getPricePrediction(product.id, product.last_price);
        }
        res.json(rows);
    });
});

// Remove product from wishlist
app.delete('/wishlist/remove', (req, res) => {
    const { userId, productId } = req.body;
    if (!userId || !productId) {
        return res.status(400).json({ error: 'User ID and Product ID are required.' });
    }

    db.run(`DELETE FROM wishlists WHERE user_id = ? AND product_id = ?`, [userId, productId], function(err) {
        if (err) {
            console.error('Error removing from wishlist:', err.message);
            return res.status(500).json({ error: 'Failed to remove from wishlist.' });
        }
        res.json({ message: this.changes > 0 ? 'Removed from wishlist.' : 'Not found in wishlist.' });
    });
});

// --- Registration Endpoint ---
app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO customers (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
        [name, email, password_hash, Date.now()],
        async function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(409).json({ error: 'Email already registered.' });
                }
                return res.status(500).json({ error: 'Registration failed.' });
            }
            await sendWelcomeEmail(email, name);
            res.json({ message: 'Registration successful!' });
        }
    );
});

// --- Login Endpoint ---
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }
    db.get(`SELECT * FROM customers WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }
        // For simplicity, return user info (in production, use JWT/session)
        res.json({ id: user.id, name: user.name, email: user.email });
    });
});

// --- Cart Endpoints ---

// Add to cart (also used for setting/unsetting reminder price)
app.post('/cart/add', (req, res) => {
    const { userId, productId, reminderPrice } = req.body;
    if (!userId || !productId) {
        return res.status(400).json({ error: 'User ID and Product ID are required.' });
    }

    // Check if the product exists in the products table
    db.get(`SELECT id FROM products WHERE id = ?`, [productId], (err, product) => {
        if (err || !product) {
            console.error('Product not found in products table:', productId);
            return res.status(404).json({ error: 'Product not found. Please search for it first.' });
        }

        // Check if the user exists in the customers table
        db.get(`SELECT id FROM customers WHERE id = ?`, [userId], (err, customer) => {
            if (err || !customer) {
                console.error('Customer not found for userId:', userId);
                return res.status(404).json({ error: 'User not found. Please log in.' });
            }

            // Insert or replace into cart
            db.run(`INSERT OR REPLACE INTO cart (user_id, product_id, reminder_price, added_at) VALUES (?, ?, ?, ?)`,
                [userId, productId, reminderPrice === undefined ? null : reminderPrice, Date.now()], // Handle undefined reminderPrice as null
                function(err) {
                    if (err) {
                        console.error('Failed to add/update cart:', err.message);
                        return res.status(500).json({ error: 'Failed to add to cart.' });
                    }
                    res.json({ message: 'Cart updated successfully.' });
                }
            );
        });
    });
});

// Get cart
app.get('/cart', (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.status(400).json({ error: 'User ID is required.' });
    }
    db.all(`SELECT p.*, c.reminder_price, c.added_at FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?`, [userId], (err, rows) => {
        if (err) {
            console.error('Error fetching cart:', err.message);
            return res.status(500).json({ error: 'Failed to fetch cart.' });
        }
        res.json(rows);
    });
});

// Remove from cart
app.delete('/cart/remove', (req, res) => {
    const { userId, productId } = req.body;
    if (!userId || !productId) {
        return res.status(400).json({ error: 'User ID and Product ID are required.' });
    }
    db.run(`DELETE FROM cart WHERE user_id = ? AND product_id = ?`, [userId, productId], function(err) {
        if (err) {
            console.error('Error removing from cart:', err.message);
            return res.status(500).json({ error: 'Failed to remove from cart.' });
        }
        res.json({ message: this.changes > 0 ? 'Removed from cart.' : 'Not found in cart.' });
    });
});

// --- Helper: Send Welcome Email ---
async function sendWelcomeEmail(email, name) {
    // Configure your SMTP transport (use a real SMTP in production)
    let transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.SMTP_USER || 'your.email@gmail.com', // Replace with your actual email
            pass: process.env.SMTP_PASS || 'yourpassword' // Replace with your actual password or app password
        }
    });
    const mailOptions = {
        from: 'SmartSpend <no-reply@smartspend.com>',
        to: email,
        subject: 'Welcome to SmartSpend!',
        text: `Hi ${name},\n\nWelcome to SmartSpend! Start tracking prices and saving today.\n\nBest,\nThe SmartSpend Team`
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log('Welcome email sent to', email);
    } catch (err) {
        console.error('Error sending welcome email:', err.message);
    }
}

// --- Price Drop Notification Worker (runs every 10 min) ---
setInterval(() => {
    db.all(`SELECT c.user_id, c.product_id, c.reminder_price, p.title, p.last_price, cu.email, cu.name FROM cart c JOIN products p ON c.product_id = p.id JOIN customers cu ON c.user_id = cu.id WHERE c.reminder_price IS NOT NULL`, [], (err, rows) => {
        if (err) {
            console.error('Error in price drop check:', err.message);
            return;
        }
        rows.forEach(async (row) => {
            const currentPrice = parseFloat((row.last_price || '').replace(/[^0-9.]/g, ''));
            const reminderPrice = parseFloat((row.reminder_price || '').replace(/[^0-9.]/g, ''));
            
            // Only send email if both prices are valid numbers and current price is less than or equal to reminder price
            if (!isNaN(currentPrice) && !isNaN(reminderPrice) && currentPrice <= reminderPrice) {
                console.log(`Price drop detected for ${row.title}: Current ${row.last_price}, Reminder ${row.reminder_price}. Sending email to ${row.email}`);
                await sendPriceDropEmail(row.email, row.name, row.title, row.last_price);
                // Remove reminder to avoid spamming
                db.run(`UPDATE cart SET reminder_price = NULL WHERE user_id = ? AND product_id = ?`, [row.user_id, row.product_id], function(updateErr) {
                    if (updateErr) {
                        console.error('Error clearing reminder price:', updateErr.message);
                    } else {
                        console.log(`Reminder for ${row.title} (user ${row.user_id}) cleared.`);
                    }
                });
            }
        });
    });
}, 10 * 60 * 1000); // Every 10 minutes

// --- Helper: Send Price Drop Email ---
async function sendPriceDropEmail(email, name, productTitle, price) {
    let transporter = nodemailer.createTransport({
        service: 'gmail', // You can use other services or direct SMTP
        auth: {
            user: process.env.SMTP_USER || 'your.email@gmail.com', // IMPORTANT: Replace with your actual email
            pass: process.env.SMTP_PASS || 'yourpassword' // IMPORTANT: Replace with your actual password or app password
        }
    });
    const mailOptions = {
        from: 'SmartSpend <no-reply@smartspend.com>',
        to: email,
        subject: 'Price Drop Alert!',
        text: `Hi ${name},\n\nGood news! The price for "${productTitle}" has dropped to ${price}.\nCheck it out on SmartSpend!\\n\nBest,\nThe SmartSpend Team`
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log('Price drop email sent to', email);
    } catch (err) {
        console.error('Error sending price drop email:', err.message);
    }
}

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log('Make sure to set your SERP_API_KEY, SMTP_USER, and SMTP_PASS in the environment variables');
});
