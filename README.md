# Scourtero - Smart Shopping Advisor

Scourtero is a smart shopping companion that helps you find the best prices for products across multiple online stores. It provides price predictions and helps you make informed purchasing decisions.

## Features

- Search products by text or image
- Compare prices across multiple online stores
- Get price predictions (Buy Now, Wait, or Fair Price)
- Save products to your wishlist
- Track price changes over time
- Dark/Light theme support

## Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- A SerpAPI key (get one at https://serpapi.com/)

## Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd scourtero
```

2. Install dependencies:
```bash
npm install
```

3. Set up your environment variables:
   - Create a `.env` file in the root directory
   - Add your SerpAPI key:
   ```
   SERP_API_KEY=your_serpapi_key_here
   PORT=3000
   SMTP_USER=your_smtp_email@example.com
   SMTP_PASS=your_smtp_password
   ```

4. Start the server:
```bash
node server.js
```

5. Open your browser and navigate to:
```
http://localhost:3000
```

## Usage

1. Enter a product name in the search box or upload an image
2. Click the search button
3. View the results and price predictions
4. Add interesting products to your wishlist
5. Track price changes over time

## Troubleshooting

If you encounter any issues:

1. Make sure the server is running at http://localhost:3000
2. Check that your SerpAPI key is valid and properly set
3. Ensure all dependencies are installed
4. Check the browser console for any error messages

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Environment Variables

- `SERP_API_KEY`: Your SerpAPI key
- `SMTP_USER`: Your SMTP email address (for sending emails)
- `SMTP_PASS`: Your SMTP password or app password

## New API Endpoints

### Registration
- `POST /register` { name, email, password }

### Login
- `POST /login` { email, password }

### Cart
- `POST /cart/add` { userId, productId, reminderPrice (optional) }
- `GET /cart?userId=...`
- `DELETE /cart/remove` { userId, productId }

### Price Drop Notification
- Users receive an email if a product in their cart drops below their set reminder price. 