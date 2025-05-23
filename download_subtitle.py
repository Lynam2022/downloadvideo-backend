
import sys
from pytube import YouTube

def download_subtitle(video_url, lang):
    try:
        yt = YouTube(video_url)
        caption = yt.captions.get_by_language_code(lang)
        if caption:
            return caption.generate_srt_captions()
        return None
    except Exception as e:
        return f"Error: {str(e)}"

if __name__ == "__main__":
    video_url = sys.argv[1]
    lang = sys.argv[2]
    result = download_subtitle(video_url, lang)
    print(result if result else "No captions found")
