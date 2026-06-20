# Inkwell

A full-stack blogging platform where people can register, publish stories, and discuss them in comments.

## Features

- Registration and login with `scrypt` password hashing
- HTTP-only, database-backed session cookies
- Create, edit, and delete posts
- Add and moderate comments
- RESTful JSON API
- SQLite database with foreign keys and indexes
- Responsive, accessible browser interface
- No third-party runtime dependencies

## Requirements

- Node.js 22.5 or newer

## Run locally

```bash
npm start
```

Open <http://localhost:3000>. The SQLite database is created automatically at `data/blog.db`.

For automatic server restarts during development:

```bash
npm run dev
```

## Deploy

The included `render.yaml` can deploy the application as a Render web
service. Connect the GitHub repository in Render and choose **New Blueprint**.

The free Render filesystem is ephemeral, so SQLite data can reset when the
service is redeployed or restarted. Attach a persistent disk and set the data
directory to that mount path for production use.

## REST API

| Method | Endpoint | Authentication | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | No | Create an account |
| POST | `/api/auth/login` | No | Log in |
| POST | `/api/auth/logout` | No | Log out |
| GET | `/api/auth/me` | No | Get current user |
| GET | `/api/posts` | No | List posts |
| GET | `/api/posts/:id` | No | Read a post and comments |
| POST | `/api/posts` | Yes | Create a post |
| PUT | `/api/posts/:id` | Owner | Update a post |
| DELETE | `/api/posts/:id` | Owner | Delete a post |
| POST | `/api/posts/:id/comments` | Yes | Add a comment |
| DELETE | `/api/comments/:id` | Author/post owner | Delete a comment |

## Project structure

```text
.
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── data/          # Created at runtime
├── server.js
└── package.json
```
