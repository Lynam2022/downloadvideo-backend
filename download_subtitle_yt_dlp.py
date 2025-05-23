
import sys
from yt_dlp import YoutubeDL

def download_subtitle(video_url, lang, output_path):
    try:
        ydl_opts = {
            'skip_download': True,
            'writesubtitles': True,
            'writeautomaticsub': True,
            'subtitleslangs': [lang],
            'subtitlesformat': 'vtt',
            'outtmpl': output_path
        }
        with YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])
        return True
    except Exception as e:
        return f"Error: {str(e)}"

if __name__ == "__main__":
    video_url = sys.argv[1]
    lang = sys.argv[2]
    output_path = sys.argv[3]
    result = download_subtitle(video_url, lang, output_path)
    print(result if result else "No captions found")
