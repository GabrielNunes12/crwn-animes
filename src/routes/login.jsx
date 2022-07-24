const Login = () => {
  return (
    <>
      <section className="login-form">
        <div className="username-info">
          <label>Username</label>
          <input type="text" name="username" placeholder="Your username" />
        </div>
        <div className="password-info">
          <label>Password</label>
          <input type="password" name="Password" placeholder="Your password" />
        </div>
      </section>
    </>
  );
};

export default Login;
