# Deploy via Railway Web UI (No CLI Needed)

## Step 1: Setup Railway Project

1. **Go to Railway:** https://railway.app
2. **Sign up with GitHub**
3. **Click "New Project"**
4. **Select "Deploy from GitHub repo"**
5. **Connect your GitHub account** (if not already)
6. **Push your code to GitHub first:**

```bash
cd c:\Users\Takudzwa\Projects\Inferth-Mapping
git init
git add .
git commit -m "Initial commit with authentication system"
git remote add origin https://github.com/YOUR_USERNAME/inferth-mapping.git
git push -u origin main
```

## Step 2: Deploy on Railway

1. **Select your GitHub repo** in Railway
2. **Railway will detect it's a Docker project**
3. **Add PostgreSQL:**
   - Click "New" → "Database" → "PostgreSQL"
4. **Set Environment Variables:**
   - Click on your service
   - Go to "Variables" tab
   - Add:
     - `JWT_SECRET`: `your-secret-key-here-make-it-long-and-random`
     - `JWT_ALGORITHM`: `HS256`
   - DATABASE_URL will be auto-set

## Step 3: Deploy Specific Directory

Since your backend is in `/backend` folder:
1. In Railway project settings
2. Set **Root Directory**: `/backend`
3. Railway will use the Dockerfile there

## Step 4: Create Admin User

After deployment:
1. Go to Railway project → Your service
2. Click "⋮" menu → "Shell"
3. Run: `python create_admin.py`

## Step 5: Get Your Backend URL

1. In Railway, go to your service
2. Click "Settings" → "Domains"
3. Click "Generate Domain"
4. Copy the URL (e.g., `https://your-app.up.railway.app`)

---

## Alternative: Deploy Without GitHub

1. **Create `.railwayignore`** file (optional)
2. **Use Railway's manual deployment** (upload ZIP)

---

## Next: Deploy Frontend to Vercel

Once backend is live, we'll update the frontend API URL and deploy to Vercel.

Your Railway backend URL: `_________` (fill in after deployment)
