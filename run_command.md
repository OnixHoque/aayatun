# Instructions to create and activate the Python 3.10 Virtual Environment

1. **Install Python 3.10:**
   ```bash
   sudo apt-get update
   sudo apt-get install python3.10
   ```

2. **Create a virtual environment:**
   ```bash
   python3.10 -m venv venv
   ```

3. **Activate the virtual environment:**
   ```bash
   source venv/bin/activate
   ```

4. **Install dependencies from requirements.txt:**
   ```bash
   pip install -r requirements.txt
   ```

5. **To deactivate the virtual environment when done:**
   ```bash
   deactivate
   ```


# Run the app for testing

flask --app app.py run --debug