"""Run the whole pipeline:  python pipeline/build.py

load CSVs -> train + forecast -> write site/data/agricast.db and model_report.json
Safe to run twice: the database is rebuilt from scratch.
"""
import load_data
import train
import build_site_data


def main():
    df, files_info, load_report = load_data.load_all()
    print("\n".join(load_report))
    print()

    result = train.run(df)
    print("\n".join(result["report"]))
    print()

    build_site_data.write_database(df, files_info, result)
    build_site_data.write_report(result)
    print("\n".join(build_site_data.verify()))


if __name__ == "__main__":
    main()
