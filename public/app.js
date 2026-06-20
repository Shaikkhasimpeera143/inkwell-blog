const state = { user: null, posts: [], activePost: null, authMode: "login" };

const app = document.querySelector("#app");
const nav = document.querySelector("#nav-actions");
const modalRoot = document.querySelector("#modal-root");
const toast = document.querySelector("#toast");

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function showToast(message, error = false) {
  toast.textContent = message;
  toast.className = `toast show${error ? " error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.className = "toast"), 3000);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(`${value.replace(" ", "T")}Z`));
}

function initials(name) {
  return name.trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === "className") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined) node.setAttribute(key, value);
  });
  children.flat().forEach((child) => node.append(child instanceof Node ? child : document.createTextNode(child)));
  return node;
}

function renderNav() {
  nav.replaceChildren();
  if (state.user) {
    nav.append(
      el("span", { className: "nav-name" }, `Hi, ${state.user.name.split(" ")[0]}`),
      el("button", { className: "button outline small", onClick: openEditor }, "Write"),
      el("button", { className: "button small", onClick: logout }, "Log out"),
    );
  } else {
    nav.append(
      el("button", { className: "button", onClick: () => openAuth("login") }, "Sign in"),
      el("button", { className: "button primary small", onClick: () => openAuth("register") }, "Join Inkwell"),
    );
  }
}

function renderPosts() {
  const list = document.querySelector("#post-list");
  document.querySelector("#story-count").textContent = `${state.posts.length} ${state.posts.length === 1 ? "story" : "stories"}`;
  list.replaceChildren();
  if (!state.posts.length) {
    list.append(el("div", { className: "empty" },
      el("h3", {}, "The first page is blank."),
      el("p", {}, "Be the first person to publish a story on Inkwell."),
    ));
    return;
  }
  state.posts.forEach((post) => {
    const excerpt = post.body.length > 220 ? `${post.body.slice(0, 220).trim()}…` : post.body;
    list.append(el("article", {
      className: "post-card",
      tabIndex: "0",
      onClick: () => openPost(post.id),
      onKeydown: (event) => event.key === "Enter" && openPost(post.id),
    },
      el("div", { className: "author" },
        el("span", { className: "avatar" }, initials(post.author_name)),
        el("div", {}, el("strong", {}, post.author_name), el("div", { className: "muted" }, formatDate(post.created_at))),
      ),
      el("h3", {}, post.title),
      el("p", { className: "post-excerpt" }, excerpt),
      el("div", { className: "post-meta" },
        el("span", {}, `${Math.max(1, Math.ceil(post.body.split(/\s+/).length / 200))} min read`),
        el("span", {}, `${post.comment_count} ${post.comment_count === 1 ? "comment" : "comments"}`),
      ),
    ));
  });
}

function openAuth(mode = "login") {
  state.authMode = mode;
  const fragment = document.querySelector("#auth-template").content.cloneNode(true);
  modalRoot.replaceChildren(fragment);
  updateAuthMode();
  document.querySelector("#auth-form").addEventListener("submit", submitAuth);
  document.querySelector('input[name="email"]').focus();
}

function updateAuthMode() {
  const registering = state.authMode === "register";
  document.querySelectorAll(".auth-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.authMode === state.authMode));
  document.querySelector("#name-field").classList.toggle("hidden", !registering);
  const nameInput = document.querySelector('input[name="name"]');
  nameInput.required = registering;
  document.querySelector('input[name="password"]').autocomplete = registering ? "new-password" : "current-password";
  document.querySelector("#auth-title").textContent = registering ? "Create your account" : "Sign in to continue";
  document.querySelector("#auth-subtitle").textContent = registering
    ? "A quiet corner of the internet for your ideas."
    : "Join the conversation and share your ideas.";
  document.querySelector("#auth-form button").textContent = registering ? "Create account" : "Sign in";
  document.querySelector("#auth-error").textContent = "";
}

async function submitAuth(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form);
  try {
    const data = await api(`/api/auth/${state.authMode}`, { method: "POST", body: JSON.stringify(payload) });
    state.user = data.user;
    closeModal();
    renderNav();
    showToast(state.authMode === "register" ? "Account created. Welcome to Inkwell." : "Welcome back.");
  } catch (error) {
    document.querySelector("#auth-error").textContent = error.message;
  }
}

function openEditor(post = null) {
  if (!state.user) return openAuth("login");
  const modal = el("div", { className: "modal-backdrop", "data-action": "close-modal" },
    el("section", { className: "modal", role: "dialog", "aria-modal": "true" },
      el("button", { className: "icon-button close", "data-action": "close-modal", "aria-label": "Close" }, "×"),
      el("p", { className: "eyebrow" }, post ? "Refine your story" : "New story"),
      el("h2", {}, post ? "Edit post" : "Write something worth sharing"),
      el("form", { className: "stack-form", id: "post-form" },
        el("label", {}, "Title", el("input", { name: "title", maxLength: "150", required: "", value: post?.title || "" })),
        el("label", {}, "Story", el("textarea", { name: "body", maxLength: "20000", required: "" }, post?.body || "")),
        el("p", { className: "form-error", id: "post-error" }),
        el("button", { className: "button primary full", type: "submit" }, post ? "Save changes" : "Publish story"),
      ),
    ),
  );
  modalRoot.replaceChildren(modal);
  document.querySelector("#post-form").addEventListener("submit", (event) => savePost(event, post?.id));
  document.querySelector('input[name="title"]').focus();
}

async function savePost(event, id) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const data = await api(id ? `/api/posts/${id}` : "/api/posts", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    closeModal();
    await loadPosts();
    showToast(id ? "Story updated." : "Story published.");
    if (!id) openPost(data.id);
  } catch (error) {
    document.querySelector("#post-error").textContent = error.message;
  }
}

async function openPost(id) {
  try {
    const data = await api(`/api/posts/${id}`);
    state.activePost = data;
    renderPostModal();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderPostModal() {
  const { post, comments } = state.activePost;
  const ownsPost = state.user?.id === post.author_id;
  const article = el("section", { className: "modal article-modal", role: "dialog", "aria-modal": "true" },
    el("button", { className: "icon-button close", "data-action": "close-modal", "aria-label": "Close" }, "×"),
    el("header", { className: "article-header" },
      el("p", { className: "eyebrow" }, `By ${post.author_name}`),
      el("h2", {}, post.title),
      el("div", { className: "muted" }, `${formatDate(post.created_at)} · ${Math.max(1, Math.ceil(post.body.split(/\s+/).length / 200))} min read`),
      ownsPost ? el("div", { className: "article-actions" },
        el("button", { className: "button outline small", onClick: () => openEditor(post) }, "Edit"),
        el("button", { className: "button danger small", onClick: () => deletePost(post.id) }, "Delete"),
      ) : "",
    ),
    el("div", { className: "article-body" }, post.body),
    renderComments(comments, post),
  );
  modalRoot.replaceChildren(el("div", { className: "modal-backdrop", "data-action": "close-modal" }, article));
}

function renderComments(comments, post) {
  const section = el("section", { className: "comments" },
    el("h3", {}, `Conversation (${comments.length})`),
  );
  if (state.user) {
    const form = el("form", { className: "stack-form comment-form" },
      el("label", {}, "Add to the conversation", el("textarea", { name: "body", maxLength: "2000", required: "", placeholder: "Write a thoughtful response…" })),
      el("p", { className: "form-error" }),
      el("button", { className: "button primary", type: "submit" }, "Post comment"),
    );
    form.addEventListener("submit", (event) => submitComment(event, post.id));
    section.append(form);
  } else {
    section.append(el("p", { className: "sign-in-note" },
      "Sign in to join the conversation. ",
      el("button", { className: "button text-button", onClick: () => openAuth("login") }, "Sign in"),
    ));
  }
  comments.forEach((comment) => {
    const canDelete = state.user && (state.user.id === comment.author_id || state.user.id === post.author_id);
    section.append(el("article", { className: "comment" },
      el("div", { className: "comment-top" },
        el("div", { className: "author" },
          el("span", { className: "avatar" }, initials(comment.author_name)),
          el("strong", {}, comment.author_name),
        ),
        el("div", {},
          el("time", {}, formatDate(comment.created_at)),
          canDelete ? el("button", { className: "comment-delete", onClick: () => deleteComment(comment.id, post.id) }, " · Delete") : "",
        ),
      ),
      el("p", {}, comment.body),
    ));
  });
  return section;
}

async function submitComment(event, postId) {
  event.preventDefault();
  const body = new FormData(event.currentTarget).get("body");
  try {
    await api(`/api/posts/${postId}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    await openPost(postId);
    await loadPosts();
    showToast("Comment posted.");
  } catch (error) {
    event.currentTarget.querySelector(".form-error").textContent = error.message;
  }
}

async function deletePost(id) {
  if (!confirm("Delete this story and all of its comments? This cannot be undone.")) return;
  try {
    await api(`/api/posts/${id}`, { method: "DELETE" });
    closeModal();
    await loadPosts();
    showToast("Story deleted.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteComment(id, postId) {
  if (!confirm("Delete this comment?")) return;
  try {
    await api(`/api/comments/${id}`, { method: "DELETE" });
    await openPost(postId);
    await loadPosts();
    showToast("Comment deleted.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function closeModal() {
  modalRoot.replaceChildren();
  state.activePost = null;
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  state.user = null;
  closeModal();
  renderNav();
  showToast("You have been signed out.");
}

async function loadPosts() {
  const data = await api("/api/posts");
  state.posts = data.posts;
  renderPosts();
}

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "close-modal" && event.target.dataset.action === "close-modal") closeModal();
  if (action === "home") window.scrollTo({ top: 0, behavior: "smooth" });
  if (action === "explore") document.querySelector("#stories").scrollIntoView();
  if (action === "start-writing") state.user ? openEditor() : openAuth("register");
  const authMode = event.target.closest("[data-auth-mode]")?.dataset.authMode;
  if (authMode) { state.authMode = authMode; updateAuthMode(); }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

async function init() {
  try {
    const [{ user }] = await Promise.all([api("/api/auth/me"), loadPosts()]);
    state.user = user;
    renderNav();
  } catch (error) {
    showToast(error.message, true);
  }
}

init();
