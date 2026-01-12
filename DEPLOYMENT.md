# KABS Quotation System - Deployment Guide

## 🚀 Quick Deploy to Render

### Step 1: Prepare Your Repository

1. **Initialize Git** (if not already done):
   ```bash
   git init
   git add .
   git commit -m "Initial commit - Ready for deployment"
   ```

2. **Push to GitHub**:
   ```bash
   # Create a new repository on GitHub first, then:
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
   git branch -M main
   git push -u origin main
   ```

### Step 2: Deploy on Render

1. **Go to [Render Dashboard](https://dashboard.render.com/)**

2. **Click "New +" → "Web Service"**

3. **Connect Your Repository**:
   - Connect your GitHub account
   - Select your repository
   - Click "Connect"

4. **Configure Service**:
   - **Name**: `kabs-quotation-system` (or your choice)
   - **Region**: Choose closest to your users
   - **Branch**: `main`
   - **Root Directory**: Leave empty
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm run preview -- --port $PORT`
   - **Plan**: Free (or choose paid)

5. **Add Environment Variables**:
   Click "Advanced" → "Add Environment Variable":
   
   | Key | Value |
   |-----|-------|
   | `NODE_ENV` | `production` |
   | `GEMINI_API_KEY` | `AIzaSyDtBaSEZBJaYoPdF-jmzGUUpcqf0590BsI` |
   | `VITE_GEMINI_API_KEY` | `AIzaSyDtBaSEZBJaYoPdF-jmzGUUpcqf0590BsI` |

6. **Click "Create Web Service"**

7. **Wait for Deployment** (3-5 minutes)
   - Render will automatically build and deploy
   - You'll get a URL like: `https://kabs-quotation-system.onrender.com`

### Step 3: Verify Deployment

1. Visit your Render URL
2. Test file upload functionality
3. Verify AI extraction works

## 🔧 Troubleshooting

### Build Fails
- Check logs in Render dashboard
- Ensure all dependencies are in `package.json`
- Verify Node version compatibility

### Environment Variables Not Working
- Make sure variables are added in Render dashboard
- Restart the service after adding variables
- Check variable names match exactly

### App Not Loading
- Check if build succeeded
- Verify start command is correct
- Check Render logs for errors

## 📝 Post-Deployment

### Custom Domain (Optional)
1. Go to Settings → Custom Domain
2. Add your domain
3. Update DNS records as instructed

### Auto-Deploy
- Render auto-deploys on every push to `main` branch
- You can disable this in Settings if needed

### Monitoring
- Check logs: Dashboard → Logs
- View metrics: Dashboard → Metrics
- Set up alerts in Settings

## 🔐 Security Notes

- Never commit `.env.local` to git (already in `.gitignore`)
- Keep API keys secure in Render environment variables
- Rotate API keys periodically
- Use Render's secret management for sensitive data

## 📊 Performance

- Free tier: 512 MB RAM, shared CPU
- Spins down after 15 min of inactivity
- First request after spin-down takes ~30 seconds
- Consider paid plan for production use

## 🆘 Support

- [Render Documentation](https://render.com/docs)
- [Render Community](https://community.render.com/)
- Check application logs for errors

---

**Your app is now deployment-ready! 🎉**
