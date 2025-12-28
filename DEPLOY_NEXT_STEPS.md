# 🚀 Railway Deployment - Next Steps

## Your Code is Ready! ✅

Git repository initialized and code committed.

---

## Deploy to Railway (5 minutes)

### Step 1: Create GitHub Repository
1. Go to https://github.com/new
2. Repository name: `inferth-mapping`
3. Make it **Public** (for free Railway deployment)
4. **Don't** initialize with README
5. Click "Create repository"

### Step 2: Push Your Code to GitHub
```bash
git remote add origin https://github.com/YOUR_USERNAME/inferth-mapping.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

### Step 3: Deploy on Railway
1. Go to https://railway.app
2. Sign up/login with GitHub
3. Click "**New Project**"
4. Select "**Deploy from GitHub repo**"
5. Choose **inferth-mapping**
6. Railway will auto-detect Docker and start deploying!

### Step 4: Add PostgreSQL Database
1. In your Railway project, click "**New**"
2. Select "**Database**" → "**PostgreSQL**"
3. Railway will automatically connect it to your backend

### Step 5: Set Environment Variables
1. Click on your backend service
2. Go to "**Variables**" tab
3. Add these variables:
   ```
   JWT_SECRET=your-super-secret-key-change-this-to-something-random
   JWT_ALGORITHM=HS256
   ```
4. DATABASE_URL is auto-set by Railway

### Step 6: Get Your Backend URL
1. In Railway, click your service
2. Go to "**Settings**" → "**Networking**"
3. Click "**Generate Domain**"
4. Copy the URL (e.g., `https://inferth-mapping.up.railway.app`)

---

## After Deployment

### Create Admin User
1. In Railway, click your service
2. Click "**⋮**" → "**Shell**"
3. Run: `python create_admin.py`

Your admin account will be created with:
- Email: adriankwaramba@gmail.com
- Password: Kingcarter@1

### Test Your Login
1. Go to: `https://YOUR-APP.up.railway.app/static/login.html`
2. Login with your credentials
3. It will work perfectly! 🎉

---

## Cost
- **Free!** Railway gives you $5 credit/month
- Your app will run free on the starter plan

---

## Need Help?
If you get stuck:
1. Check Railway logs (click service → "Deployments" → latest deployment)
2. Make sure environment variables are set
3. PostgreSQL database is connected

**Your authentication system is ready to go live!** 🚀
