# Search by meaning

Readers choose **Search by meaning** in the search dialog or on the results page. A browser worker embeds the question with multilingual E5-small and compares it with prebuilt verse embeddings. It ranks by cosine similarity and returns up to ten ayat from the English translation corpus. The normal Flask results page displays the Arabic verse and English translation.

## Deploy

Ship the files under `static/meaning/` with the app. They add about 2.4 MB of static files. The Flask app uses its existing dependencies, verifies the translation index, and looks up the selected references. It runs no model and needs no inference service or API key.

The browser fetches the pinned Transformers.js runtime from jsDelivr and the pinned ONNX model from Hugging Face. The first use transfers about 140 MB and can take longer on slow connections or devices. The browser can cache model files. Each new results page starts a new worker when a reader next chooses meaning search. The question goes to the Aayatun results page. The model asset hosts receive download requests without the question.

To serve the same model from the app, copy these files to `static/meaning/models/Xenova/multilingual-e5-small/`. [Pinned ONNX model files](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78)

- `config.json`
- `tokenizer_config.json`
- `tokenizer.json`
- `onnx/model_int8.onnx`

Set `AAYATUN_LOCAL_MEANING_MODEL=1` in Flask's environment. Serve the large files through static hosting when possible. The model is published under the [upstream MIT license](https://huggingface.co/intfloat/multilingual-e5-small).

## Rebuild the verse embeddings

When the English translation changes, rebuild `db/search.db`, then run `python build_meaning_index.py` from the app folder in an offline build environment with NumPy, PyTorch, Transformers, and the pinned E5 checkpoint cached. Publish the generated manifest and vector file together. Flask rejects verse lists from an index based on a different translation corpus.

To hide the mode, remove the deployed `static/meaning/index.json`.
