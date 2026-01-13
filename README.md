# KABS Quotation and Drawing System

A modern web application for kitchen cabinet quotation and AI-powered drawing analysis.

## Features

- 🤖 AI-powered cabinet code extraction from PDFs and images
- 📊 Automated quotation generation
- 💾 Excel pricing engine integration
- 🎨 Modern, responsive UI
- ⚡ Fast processing with Gemini AI

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite
- **AI**: Google Gemini 2.5 Flash Lite
- **Storage**: Supabase
- **Styling**: Custom CSS
- **PDF Processing**: jsPDF + jsPDF-AutoTable
- **Excel**: XLSX.js

## Deployment

### Deploy to Render

1. Push your code to GitHub
2. Connect your GitHub repo to Render
3. Render will auto-detect the `render.yaml` configuration
4. Add environment variables in Render dashboard:
   - `GEMINI_API_KEY`: Your Google AI API key
   - `VITE_GEMINI_API_KEY`: Same as above (for Vite)

### Environment Variables

Create a `.env.local` file (not committed to git):

```env
GEMINI_API_KEY=your_api_key_here
VITE_GEMINI_API_KEY=your_api_key_here
```

## Local Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Project Structure

```
├── components/       # Reusable UI components
├── services/         # AI, storage, pricing services
├── views/           # Page components
├── types.ts         # TypeScript type definitions
├── constants.ts     # Application constants
└── vite.config.ts   # Vite configuration
```

## License

Private - All rights reserved
